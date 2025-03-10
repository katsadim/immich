import { AssetType, LibraryType } from '@app/infra/entities';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { R_OK } from 'node:constants';
import { Stats } from 'node:fs';
import path from 'node:path';
import { basename, parse } from 'path';
import { AccessCore, IAccessRepository, Permission } from '../access';
import { IAssetRepository, WithProperty } from '../asset';
import { AuthUserDto } from '../auth';
import { ICryptoRepository } from '../crypto';
import { mimeTypes } from '../domain.constant';
import { usePagination } from '../domain.util';
import {
  IBaseJob,
  IEntityJob,
  IJobRepository,
  ILibraryFileJob,
  ILibraryRefreshJob,
  IOfflineLibraryFileJob,
  JOBS_ASSET_PAGINATION_SIZE,
  JobName,
} from '../job';
import { IStorageRepository } from '../storage';
import { IUserRepository } from '../user';
import {
  CreateLibraryDto,
  LibraryResponseDto,
  LibraryStatsResponseDto,
  ScanLibraryDto,
  UpdateLibraryDto,
  mapLibrary,
} from './library.dto';
import { ILibraryRepository } from './library.repository';

@Injectable()
export class LibraryService {
  readonly logger = new Logger(LibraryService.name);
  private access: AccessCore;

  constructor(
    @Inject(IAccessRepository) accessRepository: IAccessRepository,
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(ICryptoRepository) private cryptoRepository: ICryptoRepository,
    @Inject(IJobRepository) private jobRepository: IJobRepository,
    @Inject(ILibraryRepository) private repository: ILibraryRepository,
    @Inject(IStorageRepository) private storageRepository: IStorageRepository,
    @Inject(IUserRepository) private userRepository: IUserRepository,
  ) {
    this.access = new AccessCore(accessRepository);
  }

  async getStatistics(authUser: AuthUserDto, id: string): Promise<LibraryStatsResponseDto> {
    await this.access.requirePermission(authUser, Permission.LIBRARY_READ, id);
    return this.repository.getStatistics(id);
  }

  async getCount(authUser: AuthUserDto): Promise<number> {
    return this.repository.getCountForUser(authUser.id);
  }

  async getAllForUser(authUser: AuthUserDto): Promise<LibraryResponseDto[]> {
    const libraries = await this.repository.getAllByUserId(authUser.id);
    return libraries.map((library) => mapLibrary(library));
  }

  async get(authUser: AuthUserDto, id: string): Promise<LibraryResponseDto> {
    await this.access.requirePermission(authUser, Permission.LIBRARY_READ, id);
    const library = await this.findOrFail(id);
    return mapLibrary(library);
  }

  async handleQueueCleanup(): Promise<boolean> {
    this.logger.debug('Cleaning up any pending library deletions');
    const pendingDeletion = await this.repository.getAllDeleted();
    for (const libraryToDelete of pendingDeletion) {
      await this.jobRepository.queue({ name: JobName.LIBRARY_DELETE, data: { id: libraryToDelete.id } });
    }
    return true;
  }

  async create(authUser: AuthUserDto, dto: CreateLibraryDto): Promise<LibraryResponseDto> {
    switch (dto.type) {
      case LibraryType.EXTERNAL:
        if (!dto.name) {
          dto.name = 'New External Library';
        }
        break;
      case LibraryType.UPLOAD:
        if (!dto.name) {
          dto.name = 'New Upload Library';
        }
        if (dto.importPaths && dto.importPaths.length > 0) {
          throw new BadRequestException('Upload libraries cannot have import paths');
        }
        if (dto.exclusionPatterns && dto.exclusionPatterns.length > 0) {
          throw new BadRequestException('Upload libraries cannot have exclusion patterns');
        }
        break;
    }

    const library = await this.repository.create({
      ownerId: authUser.id,
      name: dto.name,
      type: dto.type,
      importPaths: dto.importPaths ?? [],
      exclusionPatterns: dto.exclusionPatterns ?? [],
      isVisible: dto.isVisible ?? true,
    });

    return mapLibrary(library);
  }

  async update(authUser: AuthUserDto, id: string, dto: UpdateLibraryDto): Promise<LibraryResponseDto> {
    await this.access.requirePermission(authUser, Permission.LIBRARY_UPDATE, id);
    const library = await this.repository.update({ id, ...dto });
    return mapLibrary(library);
  }

  async delete(authUser: AuthUserDto, id: string) {
    await this.access.requirePermission(authUser, Permission.LIBRARY_DELETE, id);

    const library = await this.findOrFail(id);
    const uploadCount = await this.repository.getUploadLibraryCount(authUser.id);
    if (library.type === LibraryType.UPLOAD && uploadCount <= 1) {
      throw new BadRequestException('Cannot delete the last upload library');
    }

    await this.repository.softDelete(id);
    await this.jobRepository.queue({ name: JobName.LIBRARY_DELETE, data: { id } });
  }

  async handleDeleteLibrary(job: IEntityJob): Promise<boolean> {
    const library = await this.repository.get(job.id, true);
    if (!library) {
      return false;
    }

    // TODO use pagination
    const assetIds = await this.repository.getAssetIds(job.id, true);
    this.logger.debug(`Will delete ${assetIds.length} asset(s) in library ${job.id}`);
    for (const assetId of assetIds) {
      await this.jobRepository.queue({ name: JobName.ASSET_DELETION, data: { id: assetId, fromExternal: true } });
    }

    if (assetIds.length === 0) {
      this.logger.log(`Deleting library ${job.id}`);
      await this.repository.delete(job.id);
    }
    return true;
  }

  async handleAssetRefresh(job: ILibraryFileJob) {
    const assetPath = path.normalize(job.assetPath);

    const user = await this.userRepository.get(job.ownerId);
    if (!user?.externalPath) {
      this.logger.warn('User has no external path set, cannot import asset');
      return false;
    }

    if (!path.normalize(assetPath).match(new RegExp(`^${path.normalize(user.externalPath)}`))) {
      this.logger.error("Asset must be within the user's external path");
      return false;
    }

    const existingAssetEntity = await this.assetRepository.getByLibraryIdAndOriginalPath(job.id, assetPath);

    let stats: Stats;
    try {
      stats = await this.storageRepository.stat(assetPath);
    } catch (error: Error | any) {
      // Can't access file, probably offline
      if (existingAssetEntity) {
        // Mark asset as offline
        this.logger.debug(`Marking asset as offline: ${assetPath}`);

        await this.assetRepository.save({ id: existingAssetEntity.id, isOffline: true });
        return true;
      } else {
        // File can't be accessed and does not already exist in db
        throw new BadRequestException("Can't access file", { cause: error });
      }
    }

    let doImport = false;
    let doRefresh = false;

    if (job.force) {
      doRefresh = true;
    }

    if (!existingAssetEntity) {
      // This asset is new to us, read it from disk
      this.logger.debug(`Importing new asset: ${assetPath}`);
      doImport = true;
    } else if (stats.mtime.toISOString() !== existingAssetEntity.fileModifiedAt.toISOString()) {
      // File modification time has changed since last time we checked, re-read from disk
      this.logger.debug(
        `File modification time has changed, re-importing asset: ${assetPath}. Old mtime: ${existingAssetEntity.fileModifiedAt}. New mtime: ${stats.mtime}`,
      );
      doRefresh = true;
    } else if (!job.force && stats && !existingAssetEntity.isOffline) {
      // Asset exists on disk and in db and mtime has not changed. Also, we are not forcing refresn. Therefore, do nothing
      this.logger.debug(`Asset already exists in database and on disk, will not import: ${assetPath}`);
    }

    if (stats && existingAssetEntity?.isOffline) {
      // File was previously offline but is now online
      this.logger.debug(`Marking previously-offline asset as online: ${assetPath}`);
      await this.assetRepository.save({ id: existingAssetEntity.id, isOffline: false });
      doRefresh = true;
    }

    if (!doImport && !doRefresh) {
      // If we don't import, exit here
      return true;
    }

    let assetType: AssetType;

    if (mimeTypes.isImage(assetPath)) {
      assetType = AssetType.IMAGE;
    } else if (mimeTypes.isVideo(assetPath)) {
      assetType = AssetType.VIDEO;
    } else {
      throw new BadRequestException(`Unsupported file type ${assetPath}`);
    }

    // TODO: doesn't xmp replace the file extension? Will need investigation
    let sidecarPath: string | null = null;
    if (await this.storageRepository.checkFileExists(`${assetPath}.xmp`, R_OK)) {
      sidecarPath = `${assetPath}.xmp`;
    }

    const deviceAssetId = `${basename(assetPath)}`.replace(/\s+/g, '');

    const pathHash = this.cryptoRepository.hashSha1(`path:${assetPath}`);

    let assetId;
    if (doImport) {
      const library = await this.repository.get(job.id, true);
      if (library?.deletedAt) {
        this.logger.error('Cannot import asset into deleted library');
        return false;
      }

      // TODO: In wait of refactoring the domain asset service, this function is just manually written like this
      const addedAsset = await this.assetRepository.create({
        ownerId: job.ownerId,
        libraryId: job.id,
        checksum: pathHash,
        originalPath: assetPath,
        deviceAssetId: deviceAssetId,
        deviceId: 'Library Import',
        fileCreatedAt: stats.mtime,
        fileModifiedAt: stats.mtime,
        localDateTime: stats.mtime,
        type: assetType,
        originalFileName: parse(assetPath).name,
        sidecarPath,
        isReadOnly: true,
        isExternal: true,
      });
      assetId = addedAsset.id;
    } else if (doRefresh && existingAssetEntity) {
      assetId = existingAssetEntity.id;
      await this.assetRepository.updateAll([existingAssetEntity.id], {
        fileCreatedAt: stats.mtime,
        fileModifiedAt: stats.mtime,
      });
    } else {
      // Not importing and not refreshing, do nothing
      return true;
    }

    this.logger.debug(`Queuing metadata extraction for: ${assetPath}`);

    await this.jobRepository.queue({ name: JobName.METADATA_EXTRACTION, data: { id: assetId, source: 'upload' } });

    if (assetType === AssetType.VIDEO) {
      await this.jobRepository.queue({ name: JobName.VIDEO_CONVERSION, data: { id: assetId } });
    }

    return true;
  }

  async queueScan(authUser: AuthUserDto, id: string, dto: ScanLibraryDto) {
    await this.access.requirePermission(authUser, Permission.LIBRARY_UPDATE, id);

    const library = await this.repository.get(id);
    if (!library || library.type !== LibraryType.EXTERNAL) {
      throw new BadRequestException('Can only refresh external libraries');
    }

    await this.jobRepository.queue({
      name: JobName.LIBRARY_SCAN,
      data: {
        id,
        refreshModifiedFiles: dto.refreshModifiedFiles ?? false,
        refreshAllFiles: dto.refreshAllFiles ?? false,
      },
    });
  }

  async queueRemoveOffline(authUser: AuthUserDto, id: string) {
    this.logger.verbose(`Removing offline files from library: ${id}`);
    await this.access.requirePermission(authUser, Permission.LIBRARY_UPDATE, id);

    await this.jobRepository.queue({
      name: JobName.LIBRARY_REMOVE_OFFLINE,
      data: {
        id,
      },
    });
  }

  async handleQueueAllScan(job: IBaseJob): Promise<boolean> {
    this.logger.debug(`Refreshing all external libraries: force=${job.force}`);

    // Queue cleanup
    await this.jobRepository.queue({ name: JobName.LIBRARY_QUEUE_CLEANUP, data: {} });

    // Queue all library refresh
    const libraries = await this.repository.getAll(true, LibraryType.EXTERNAL);
    for (const library of libraries) {
      await this.jobRepository.queue({
        name: JobName.LIBRARY_SCAN,
        data: {
          id: library.id,
          refreshModifiedFiles: !job.force,
          refreshAllFiles: job.force ?? false,
        },
      });
    }
    return true;
  }

  async handleOfflineRemoval(job: IEntityJob): Promise<boolean> {
    const assetPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) =>
      this.assetRepository.getWith(pagination, WithProperty.IS_OFFLINE, job.id),
    );

    for await (const assets of assetPagination) {
      this.logger.debug(`Removing ${assets.length} offline assets`);
      for (const asset of assets) {
        await this.jobRepository.queue({ name: JobName.ASSET_DELETION, data: { id: asset.id, fromExternal: true } });
      }
    }

    return true;
  }

  async handleQueueAssetRefresh(job: ILibraryRefreshJob): Promise<boolean> {
    const library = await this.repository.get(job.id);
    if (!library || library.type !== LibraryType.EXTERNAL) {
      this.logger.warn('Can only refresh external libraries');
      return false;
    }

    const user = await this.userRepository.get(library.ownerId);
    if (!user?.externalPath) {
      this.logger.warn('User has no external path set, cannot refresh library');
      return false;
    }

    const normalizedExternalPath = path.normalize(user.externalPath);

    this.logger.verbose(`Refreshing library: ${job.id}`);
    const crawledAssetPaths = (
      await this.storageRepository.crawl({
        pathsToCrawl: library.importPaths,
        exclusionPatterns: library.exclusionPatterns,
      })
    )
      .map(path.normalize)
      .filter((assetPath) =>
        // Filter out paths that are not within the user's external path
        assetPath.match(new RegExp(`^${normalizedExternalPath}`)),
      );

    this.logger.debug(`Found ${crawledAssetPaths.length} assets when crawling import paths ${library.importPaths}`);
    const assetsInLibrary = await this.assetRepository.getByLibraryId([job.id]);
    const offlineAssets = assetsInLibrary.filter((asset) => !crawledAssetPaths.includes(asset.originalPath));
    this.logger.debug(`${offlineAssets.length} assets in library are not present on disk and will be marked offline`);

    for (const offlineAsset of offlineAssets) {
      const offlineJobData: IOfflineLibraryFileJob = {
        id: job.id,
        assetPath: offlineAsset.originalPath,
      };

      await this.jobRepository.queue({ name: JobName.LIBRARY_MARK_ASSET_OFFLINE, data: offlineJobData });
    }

    if (crawledAssetPaths.length > 0) {
      let filteredPaths: string[] = [];
      if (job.refreshAllFiles || job.refreshModifiedFiles) {
        filteredPaths = crawledAssetPaths;
      } else {
        const existingPaths = await this.repository.getOnlineAssetPaths(job.id);
        this.logger.debug(`Found ${existingPaths.length} existing asset(s) in library ${job.id}`);

        filteredPaths = crawledAssetPaths.filter((assetPath) => !existingPaths.includes(assetPath));
        this.logger.debug(`After db comparison, ${filteredPaths.length} asset(s) remain to be imported`);
      }

      for (const assetPath of filteredPaths) {
        const libraryJobData: ILibraryFileJob = {
          id: job.id,
          assetPath: path.normalize(assetPath),
          ownerId: library.ownerId,
          force: job.refreshAllFiles ?? false,
        };

        await this.jobRepository.queue({ name: JobName.LIBRARY_SCAN_ASSET, data: libraryJobData });
      }
    }

    await this.repository.update({ id: job.id, refreshedAt: new Date() });

    return true;
  }

  async handleOfflineAsset(job: IOfflineLibraryFileJob): Promise<boolean> {
    const existingAssetEntity = await this.assetRepository.getByLibraryIdAndOriginalPath(job.id, job.assetPath);

    if (existingAssetEntity) {
      this.logger.verbose(`Marking asset as offline: ${job.assetPath}`);
      await this.assetRepository.save({ id: existingAssetEntity.id, isOffline: true });
    }

    return true;
  }

  private async findOrFail(id: string) {
    const library = await this.repository.get(id);
    if (!library) {
      throw new BadRequestException('Library not found');
    }
    return library;
  }
}
