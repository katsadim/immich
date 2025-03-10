import { SystemConfig, UserEntity } from '@app/infra/entities';
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import cookieParser from 'cookie';
import { IncomingHttpHeaders } from 'http';
import { DateTime } from 'luxon';
import { ClientMetadata, Issuer, UserinfoResponse, custom, generators } from 'openid-client';
import { IKeyRepository } from '../api-key';
import { ICryptoRepository } from '../crypto/crypto.repository';
import { ILibraryRepository } from '../library';
import { ISharedLinkRepository } from '../shared-link';
import { ISystemConfigRepository } from '../system-config';
import { SystemConfigCore } from '../system-config/system-config.core';
import { IUserRepository, UserCore, UserResponseDto } from '../user';
import {
  AuthType,
  IMMICH_ACCESS_COOKIE,
  IMMICH_API_KEY_HEADER,
  IMMICH_AUTH_TYPE_COOKIE,
  LOGIN_URL,
  MOBILE_REDIRECT,
} from './auth.constant';
import { AuthUserDto, ChangePasswordDto, LoginCredentialDto, OAuthCallbackDto, OAuthConfigDto, SignUpDto } from './dto';
import {
  AdminSignupResponseDto,
  AuthDeviceResponseDto,
  LoginResponseDto,
  LogoutResponseDto,
  OAuthAuthorizeResponseDto,
  OAuthConfigResponseDto,
  mapAdminSignupResponse,
  mapLoginResponse,
  mapUserToken,
} from './response-dto';
import { IUserTokenRepository } from './user-token.repository';

export interface LoginDetails {
  isSecure: boolean;
  clientIp: string;
  deviceType: string;
  deviceOS: string;
}

interface LoginResponse {
  response: LoginResponseDto;
  cookie: string[];
}

interface OAuthProfile extends UserinfoResponse {
  email: string;
}

@Injectable()
export class AuthService {
  private userCore: UserCore;
  private configCore: SystemConfigCore;
  private logger = new Logger(AuthService.name);

  constructor(
    @Inject(ICryptoRepository) private cryptoRepository: ICryptoRepository,
    @Inject(ISystemConfigRepository) configRepository: ISystemConfigRepository,
    @Inject(IUserRepository) userRepository: IUserRepository,
    @Inject(IUserTokenRepository) private userTokenRepository: IUserTokenRepository,
    @Inject(ILibraryRepository) libraryRepository: ILibraryRepository,
    @Inject(ISharedLinkRepository) private sharedLinkRepository: ISharedLinkRepository,
    @Inject(IKeyRepository) private keyRepository: IKeyRepository,
  ) {
    this.configCore = SystemConfigCore.create(configRepository);
    this.userCore = new UserCore(userRepository, libraryRepository, cryptoRepository);

    custom.setHttpOptionsDefaults({ timeout: 30000 });
  }

  async login(dto: LoginCredentialDto, details: LoginDetails): Promise<LoginResponse> {
    const config = await this.configCore.getConfig();
    if (!config.passwordLogin.enabled) {
      throw new UnauthorizedException('Password login has been disabled');
    }

    let user = await this.userCore.getByEmail(dto.email, true);
    if (user) {
      const isAuthenticated = this.validatePassword(dto.password, user);
      if (!isAuthenticated) {
        user = null;
      }
    }

    if (!user) {
      this.logger.warn(`Failed login attempt for user ${dto.email} from ip address ${details.clientIp}`);
      throw new UnauthorizedException('Incorrect email or password');
    }

    return this.createLoginResponse(user, AuthType.PASSWORD, details);
  }

  async logout(authUser: AuthUserDto, authType: AuthType): Promise<LogoutResponseDto> {
    if (authUser.accessTokenId) {
      await this.userTokenRepository.delete(authUser.id, authUser.accessTokenId);
    }

    return {
      successful: true,
      redirectUri: await this.getLogoutEndpoint(authType),
    };
  }

  async changePassword(authUser: AuthUserDto, dto: ChangePasswordDto) {
    const { password, newPassword } = dto;
    const user = await this.userCore.getByEmail(authUser.email, true);
    if (!user) {
      throw new UnauthorizedException();
    }

    const valid = this.validatePassword(password, user);
    if (!valid) {
      throw new BadRequestException('Wrong password');
    }

    return this.userCore.updateUser(authUser, authUser.id, { password: newPassword });
  }

  async adminSignUp(dto: SignUpDto): Promise<AdminSignupResponseDto> {
    const adminUser = await this.userCore.getAdmin();

    if (adminUser) {
      throw new BadRequestException('The server already has an admin');
    }

    const admin = await this.userCore.createUser({
      isAdmin: true,
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      password: dto.password,
      storageLabel: 'admin',
    });

    return mapAdminSignupResponse(admin);
  }

  async validate(headers: IncomingHttpHeaders, params: Record<string, string>): Promise<AuthUserDto | null> {
    const shareKey = (headers['x-immich-share-key'] || params.key) as string;
    const userToken = (headers['x-immich-user-token'] ||
      params.userToken ||
      this.getBearerToken(headers) ||
      this.getCookieToken(headers)) as string;
    const apiKey = (headers[IMMICH_API_KEY_HEADER] || params.apiKey) as string;

    if (shareKey) {
      return this.validateSharedLink(shareKey);
    }

    if (userToken) {
      return this.validateUserToken(userToken);
    }

    if (apiKey) {
      return this.validateApiKey(apiKey);
    }

    throw new UnauthorizedException('Authentication required');
  }

  async getDevices(authUser: AuthUserDto): Promise<AuthDeviceResponseDto[]> {
    const userTokens = await this.userTokenRepository.getAll(authUser.id);
    return userTokens.map((userToken) => mapUserToken(userToken, authUser.accessTokenId));
  }

  async logoutDevice(authUser: AuthUserDto, deviceId: string): Promise<void> {
    await this.userTokenRepository.delete(authUser.id, deviceId);
  }

  async logoutDevices(authUser: AuthUserDto): Promise<void> {
    const devices = await this.userTokenRepository.getAll(authUser.id);
    for (const device of devices) {
      if (device.id === authUser.accessTokenId) {
        continue;
      }
      await this.userTokenRepository.delete(authUser.id, device.id);
    }
  }

  getMobileRedirect(url: string) {
    return `${MOBILE_REDIRECT}?${url.split('?')[1] || ''}`;
  }

  async generateConfig(dto: OAuthConfigDto): Promise<OAuthConfigResponseDto> {
    const config = await this.configCore.getConfig();
    const response = {
      enabled: config.oauth.enabled,
      passwordLoginEnabled: config.passwordLogin.enabled,
    };

    if (!response.enabled) {
      return response;
    }

    const { scope, buttonText, autoLaunch } = config.oauth;
    const url = (await this.getOAuthClient(config)).authorizationUrl({
      redirect_uri: this.normalize(config, dto.redirectUri),
      scope,
      state: generators.state(),
    });

    return { ...response, buttonText, url, autoLaunch };
  }

  async authorize(dto: OAuthConfigDto): Promise<OAuthAuthorizeResponseDto> {
    const config = await this.configCore.getConfig();
    if (!config.oauth.enabled) {
      throw new BadRequestException('OAuth is not enabled');
    }

    const client = await this.getOAuthClient(config);
    const url = await client.authorizationUrl({
      redirect_uri: this.normalize(config, dto.redirectUri),
      scope: config.oauth.scope,
      state: generators.state(),
    });

    return { url };
  }

  async callback(
    dto: OAuthCallbackDto,
    loginDetails: LoginDetails,
  ): Promise<{ response: LoginResponseDto; cookie: string[] }> {
    const config = await this.configCore.getConfig();
    const profile = await this.getOAuthProfile(config, dto.url);
    this.logger.debug(`Logging in with OAuth: ${JSON.stringify(profile)}`);
    let user = await this.userCore.getByOAuthId(profile.sub);

    // link existing user
    if (!user) {
      const emailUser = await this.userCore.getByEmail(profile.email);
      if (emailUser) {
        user = await this.userCore.updateUser(emailUser, emailUser.id, { oauthId: profile.sub });
      }
    }

    // register new user
    if (!user) {
      if (!config.oauth.autoRegister) {
        this.logger.warn(
          `Unable to register ${profile.email}. To enable set OAuth Auto Register to true in admin settings.`,
        );
        throw new BadRequestException(`User does not exist and auto registering is disabled.`);
      }

      this.logger.log(`Registering new user: ${profile.email}/${profile.sub}`);
      this.logger.verbose(`OAuth Profile: ${JSON.stringify(profile)}`);

      let storageLabel: string | null = profile[config.oauth.storageLabelClaim as keyof OAuthProfile] as string;
      if (typeof storageLabel !== 'string') {
        storageLabel = null;
      }

      user = await this.userCore.createUser({
        firstName: profile.given_name || '',
        lastName: profile.family_name || '',
        email: profile.email,
        oauthId: profile.sub,
        storageLabel,
      });
    }

    return this.createLoginResponse(user, AuthType.OAUTH, loginDetails);
  }

  async link(user: AuthUserDto, dto: OAuthCallbackDto): Promise<UserResponseDto> {
    const config = await this.configCore.getConfig();
    const { sub: oauthId } = await this.getOAuthProfile(config, dto.url);
    const duplicate = await this.userCore.getByOAuthId(oauthId);
    if (duplicate && duplicate.id !== user.id) {
      this.logger.warn(`OAuth link account failed: sub is already linked to another user (${duplicate.email}).`);
      throw new BadRequestException('This OAuth account has already been linked to another user.');
    }
    return this.userCore.updateUser(user, user.id, { oauthId });
  }

  async unlink(user: AuthUserDto): Promise<UserResponseDto> {
    return this.userCore.updateUser(user, user.id, { oauthId: '' });
  }

  private async getLogoutEndpoint(authType: AuthType): Promise<string> {
    if (authType !== AuthType.OAUTH) {
      return LOGIN_URL;
    }

    const config = await this.configCore.getConfig();
    if (!config.oauth.enabled) {
      return LOGIN_URL;
    }

    const client = await this.getOAuthClient(config);
    return client.issuer.metadata.end_session_endpoint || LOGIN_URL;
  }

  private async getOAuthProfile(config: SystemConfig, url: string): Promise<OAuthProfile> {
    const redirectUri = this.normalize(config, url.split('?')[0]);
    const client = await this.getOAuthClient(config);
    const params = client.callbackParams(url);
    try {
      const tokens = await client.callback(redirectUri, params, { state: params.state });
      return client.userinfo<OAuthProfile>(tokens.access_token || '');
    } catch (error: Error | any) {
      this.logger.error(`Unable to complete OAuth login: ${error}`, error?.stack);
      throw new InternalServerErrorException(`Unable to complete OAuth login: ${error}`, { cause: error });
    }
  }

  private async getOAuthClient(config: SystemConfig) {
    const { enabled, clientId, clientSecret, issuerUrl } = config.oauth;

    if (!enabled) {
      throw new BadRequestException('OAuth2 is not enabled');
    }

    const metadata: ClientMetadata = {
      client_id: clientId,
      client_secret: clientSecret,
      response_types: ['code'],
    };

    const issuer = await Issuer.discover(issuerUrl);
    const algorithms = (issuer.id_token_signing_alg_values_supported || []) as string[];
    if (algorithms[0] === 'HS256') {
      metadata.id_token_signed_response_alg = algorithms[0];
    }

    return new issuer.Client(metadata);
  }

  private normalize(config: SystemConfig, redirectUri: string) {
    const isMobile = redirectUri.startsWith(MOBILE_REDIRECT);
    const { mobileRedirectUri, mobileOverrideEnabled } = config.oauth;
    if (isMobile && mobileOverrideEnabled && mobileRedirectUri) {
      return mobileRedirectUri;
    }
    return redirectUri;
  }

  private getBearerToken(headers: IncomingHttpHeaders): string | null {
    const [type, token] = (headers.authorization || '').split(' ');
    if (type.toLowerCase() === 'bearer') {
      return token;
    }

    return null;
  }

  private getCookieToken(headers: IncomingHttpHeaders): string | null {
    const cookies = cookieParser.parse(headers.cookie || '');
    return cookies[IMMICH_ACCESS_COOKIE] || null;
  }

  private async validateSharedLink(key: string | string[]): Promise<AuthUserDto> {
    key = Array.isArray(key) ? key[0] : key;

    const bytes = Buffer.from(key, key.length === 100 ? 'hex' : 'base64url');
    const link = await this.sharedLinkRepository.getByKey(bytes);
    if (link) {
      if (!link.expiresAt || new Date(link.expiresAt) > new Date()) {
        const user = link.user;
        if (user) {
          return {
            id: user.id,
            email: user.email,
            isAdmin: user.isAdmin,
            isPublicUser: true,
            sharedLinkId: link.id,
            isAllowUpload: link.allowUpload,
            isAllowDownload: link.allowDownload,
            isShowExif: link.showExif,
          };
        }
      }
    }
    throw new UnauthorizedException('Invalid share key');
  }

  private async validateApiKey(key: string): Promise<AuthUserDto> {
    const hashedKey = this.cryptoRepository.hashSha256(key);
    const keyEntity = await this.keyRepository.getKey(hashedKey);
    if (keyEntity?.user) {
      const user = keyEntity.user;

      return {
        id: user.id,
        email: user.email,
        isAdmin: user.isAdmin,
        isPublicUser: false,
        isAllowUpload: true,
        externalPath: user.externalPath,
      };
    }

    throw new UnauthorizedException('Invalid API key');
  }

  private validatePassword(inputPassword: string, user: UserEntity): boolean {
    if (!user || !user.password) {
      return false;
    }
    return this.cryptoRepository.compareBcrypt(inputPassword, user.password);
  }

  private async validateUserToken(tokenValue: string): Promise<AuthUserDto> {
    const hashedToken = this.cryptoRepository.hashSha256(tokenValue);
    let token = await this.userTokenRepository.getByToken(hashedToken);

    if (token?.user) {
      const now = DateTime.now();
      const updatedAt = DateTime.fromJSDate(token.updatedAt);
      const diff = now.diff(updatedAt, ['hours']);
      if (diff.hours > 1) {
        token = await this.userTokenRepository.save({ ...token, updatedAt: new Date() });
      }

      return {
        ...token.user,
        isPublicUser: false,
        isAllowUpload: true,
        isAllowDownload: true,
        isShowExif: true,
        accessTokenId: token.id,
      };
    }

    throw new UnauthorizedException('Invalid user token');
  }

  private async createLoginResponse(user: UserEntity, authType: AuthType, loginDetails: LoginDetails) {
    const key = this.cryptoRepository.randomBytes(32).toString('base64').replace(/\W/g, '');
    const token = this.cryptoRepository.hashSha256(key);

    await this.userTokenRepository.create({
      token,
      user,
      deviceOS: loginDetails.deviceOS,
      deviceType: loginDetails.deviceType,
    });

    const response = mapLoginResponse(user, key);
    const cookie = this.getCookies(response, authType, loginDetails);
    return { response, cookie };
  }

  private getCookies(loginResponse: LoginResponseDto, authType: AuthType, { isSecure }: LoginDetails) {
    const maxAge = 400 * 24 * 3600; // 400 days

    let authTypeCookie = '';
    let accessTokenCookie = '';

    if (isSecure) {
      accessTokenCookie = `${IMMICH_ACCESS_COOKIE}=${loginResponse.accessToken}; HttpOnly; Secure; Path=/; Max-Age=${maxAge}; SameSite=Lax;`;
      authTypeCookie = `${IMMICH_AUTH_TYPE_COOKIE}=${authType}; HttpOnly; Secure; Path=/; Max-Age=${maxAge}; SameSite=Lax;`;
    } else {
      accessTokenCookie = `${IMMICH_ACCESS_COOKIE}=${loginResponse.accessToken}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax;`;
      authTypeCookie = `${IMMICH_AUTH_TYPE_COOKIE}=${authType}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax;`;
    }
    return [accessTokenCookie, authTypeCookie];
  }
}
