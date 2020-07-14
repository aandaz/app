import angular from 'angular';
import { autobind } from 'core-decorators';
import { Bookmarks as NativeBookmarks, browser } from 'webextension-polyfill-ts';
import BookmarkHelperService from '../../shared/bookmark/bookmark-helper/bookmark-helper.service';
import { BookmarkChangeType, BookmarkContainer } from '../../shared/bookmark/bookmark.enum';
import {
  AddNativeBookmarkChangeData,
  Bookmark,
  BookmarkChange,
  BookmarkMetadata,
  BookmarkService,
  ModifyNativeBookmarkChangeData,
  MoveNativeBookmarkChangeData,
  RemoveNativeBookmarkChangeData
} from '../../shared/bookmark/bookmark.interface';
import * as Exceptions from '../../shared/exception/exception';
import Globals from '../../shared/global-shared.constants';
import { MessageCommand } from '../../shared/global-shared.enum';
import { PlatformService, WebpageMetadata } from '../../shared/global-shared.interface';
import LogService from '../../shared/log/log.service';
import { StoreKey } from '../../shared/store/store.enum';
import StoreService from '../../shared/store/store.service';
import SyncEngineService from '../../shared/sync/sync-engine/sync-engine.service';
import { SyncType } from '../../shared/sync/sync.enum';
import { Sync } from '../../shared/sync/sync.interface';
import UtilityService from '../../shared/utility/utility.service';
import { BookmarkIdMapping } from '../bookmark-id-mapper/bookmark-id-mapper.interface';
import BookmarkIdMapperService from '../bookmark-id-mapper/bookmark-id-mapper.service';

@autobind
export default class WebExtBookmarkService implements BookmarkService {
  $injector: ng.auto.IInjectorService;
  $q: ng.IQService;
  $timeout: ng.ITimeoutService;
  bookmarkIdMapperSvc: BookmarkIdMapperService;
  bookmarkHelperSvc: BookmarkHelperService;
  logSvc: LogService;
  platformSvc: PlatformService;
  storeSvc: StoreService;
  _syncEngineService: SyncEngineService;
  utilitySvc: UtilityService;

  nativeBookmarkEventsQueue: any[] = [];
  processNativeBookmarkEventsTimeout: ng.IPromise<void>;
  unsupportedContainers = [];

  static $inject = [
    '$injector',
    '$q',
    '$timeout',
    'BookmarkHelperService',
    'BookmarkIdMapperService',
    'LogService',
    'PlatformService',
    'StoreService',
    'UtilityService'
  ];
  constructor(
    $injector: ng.auto.IInjectorService,
    $q: ng.IQService,
    $timeout: ng.ITimeoutService,
    BookmarkHelperSvc: BookmarkHelperService,
    BookmarkIdMapperSvc: BookmarkIdMapperService,
    LogSvc: LogService,
    PlatformSvc: PlatformService,
    StoreSvc: StoreService,
    UtilitySvc: UtilityService
  ) {
    this.$injector = $injector;
    this.$q = $q;
    this.$timeout = $timeout;
    this.bookmarkIdMapperSvc = BookmarkIdMapperSvc;
    this.bookmarkHelperSvc = BookmarkHelperSvc;
    this.logSvc = LogSvc;
    this.platformSvc = PlatformSvc;
    this.storeSvc = StoreSvc;
    this.utilitySvc = UtilitySvc;
  }

  get syncEngineService(): SyncEngineService {
    if (angular.isUndefined(this._syncEngineService)) {
      this._syncEngineService = this.$injector.get('SyncEngineService');
    }
    return this._syncEngineService;
  }

  buildIdMappings(bookmarks: Bookmark[]): ng.IPromise<void> {
    const mapIds = (
      nativeBookmarks: NativeBookmarks.BookmarkTreeNode[],
      syncedBookmarks: Bookmark[]
    ): BookmarkIdMapping[] => {
      return nativeBookmarks.reduce((acc, val, index) => {
        // Create mapping for the current node
        const mapping = this.bookmarkIdMapperSvc.createMapping(syncedBookmarks[index].id, val.id);
        acc.push(mapping);

        // Process child nodes
        return val.children && val.children.length > 0
          ? acc.concat(mapIds(val.children, syncedBookmarks[index].children))
          : acc;
      }, [] as BookmarkIdMapping[]);
    };

    // Get native container ids
    return this.getNativeContainerIds()
      .then((nativeContainerIds) => {
        const menuBookmarksId: string = nativeContainerIds[BookmarkContainer.Menu];
        const mobileBookmarksId: string = nativeContainerIds[BookmarkContainer.Mobile];
        const otherBookmarksId: string = nativeContainerIds[BookmarkContainer.Other];
        const toolbarBookmarksId: string = nativeContainerIds[BookmarkContainer.Toolbar];

        // Map menu bookmarks
        const getMenuBookmarks =
          menuBookmarksId == null
            ? this.$q.resolve([] as BookmarkIdMapping[])
            : browser.bookmarks.getSubTree(menuBookmarksId).then((subTree) => {
                const menuBookmarks = subTree[0];
                if (!menuBookmarks.children || menuBookmarks.children.length === 0) {
                  return [] as BookmarkIdMapping[];
                }

                // Map ids between nodes and synced container children
                const menuBookmarksContainer = bookmarks.find((x) => {
                  return x.title === BookmarkContainer.Menu;
                });
                return !!menuBookmarksContainer &&
                  menuBookmarksContainer.children &&
                  menuBookmarksContainer.children.length > 0
                  ? mapIds(menuBookmarks.children, menuBookmarksContainer.children)
                  : ([] as BookmarkIdMapping[]);
              });

        // Map mobile bookmarks
        const getMobileBookmarks =
          mobileBookmarksId == null
            ? this.$q.resolve([] as BookmarkIdMapping[])
            : browser.bookmarks.getSubTree(mobileBookmarksId).then((subTree) => {
                const mobileBookmarks = subTree[0];
                if (!mobileBookmarks.children || mobileBookmarks.children.length === 0) {
                  return [] as BookmarkIdMapping[];
                }

                // Map ids between nodes and synced container children
                const mobileBookmarksContainer = bookmarks.find((x) => {
                  return x.title === BookmarkContainer.Mobile;
                });
                return !!mobileBookmarksContainer &&
                  mobileBookmarksContainer.children &&
                  mobileBookmarksContainer.children.length > 0
                  ? mapIds(mobileBookmarks.children, mobileBookmarksContainer.children)
                  : ([] as BookmarkIdMapping[]);
              });

        // Map other bookmarks
        const getOtherBookmarks =
          otherBookmarksId == null
            ? this.$q.resolve([] as BookmarkIdMapping[])
            : browser.bookmarks.getSubTree(otherBookmarksId).then((subTree) => {
                const otherBookmarks = subTree[0];
                if (!otherBookmarks.children || otherBookmarks.children.length === 0) {
                  return [] as BookmarkIdMapping[];
                }

                // Remove any unsupported container folders present
                const nodes = otherBookmarks.children.filter((x) => {
                  return Object.values(nativeContainerIds).indexOf(x.id) < 0;
                });

                // Map ids between nodes and synced container children
                const otherBookmarksContainer = bookmarks.find((x) => {
                  return x.title === BookmarkContainer.Other;
                });
                return !!otherBookmarksContainer &&
                  otherBookmarksContainer.children &&
                  otherBookmarksContainer.children.length > 0
                  ? mapIds(nodes, otherBookmarksContainer.children)
                  : ([] as BookmarkIdMapping[]);
              });

        // Map toolbar bookmarks if enabled
        const getToolbarBookmarks =
          toolbarBookmarksId == null
            ? this.$q.resolve([] as BookmarkIdMapping[])
            : this.$q
                .all([
                  this.bookmarkHelperSvc.getSyncBookmarksToolbar(),
                  browser.bookmarks.getSubTree(toolbarBookmarksId)
                ])
                .then((results) => {
                  const syncBookmarksToolbar = results[0];
                  const toolbarBookmarks = results[1][0];

                  if (!syncBookmarksToolbar || !toolbarBookmarks.children || toolbarBookmarks.children.length === 0) {
                    return [] as BookmarkIdMapping[];
                  }

                  // Map ids between nodes and synced container children
                  const toolbarBookmarksContainer = bookmarks.find((x) => {
                    return x.title === BookmarkContainer.Toolbar;
                  });
                  return !!toolbarBookmarksContainer &&
                    toolbarBookmarksContainer.children &&
                    toolbarBookmarksContainer.children.length > 0
                    ? mapIds(toolbarBookmarks.children, toolbarBookmarksContainer.children)
                    : ([] as BookmarkIdMapping[]);
                });

        return this.$q.all([getMenuBookmarks, getMobileBookmarks, getOtherBookmarks, getToolbarBookmarks]);
      })
      .then((results) => {
        // Combine all mappings
        const combinedMappings = results.reduce((acc, val) => {
          return acc.concat(val);
        }, []);

        // Save mappings
        return this.bookmarkIdMapperSvc.set(combinedMappings);
      });
  }

  checkIfBookmarkChangeShouldBeSynced(changedBookmark: Bookmark, bookmarks: Bookmark[]): ng.IPromise<boolean> {
    // Check if container was changed
    return this.wasContainerChanged(changedBookmark, bookmarks)
      .then((changedBookmarkIsContainer) => {
        if (changedBookmarkIsContainer) {
          throw new Exceptions.ContainerChangedException();
        }

        // If container is Toolbar, check if Toolbar sync is disabled
        const container = this.bookmarkHelperSvc.getContainerByBookmarkId(changedBookmark.id, bookmarks);
        if (!container) {
          throw new Exceptions.ContainerNotFoundException();
        }
        return container.title === BookmarkContainer.Toolbar
          ? this.bookmarkHelperSvc.getSyncBookmarksToolbar()
          : this.$q.resolve(true);
      })
      .then((syncBookmarksToolbar) => {
        if (!syncBookmarksToolbar) {
          this.logSvc.logInfo('Not syncing toolbar');
          return false;
        }

        return true;
      });
  }

  checkPermsAndGetPageMetadata(): ng.IPromise<WebpageMetadata> {
    return this.platformSvc.permissions_Check().then((hasPermissions) => {
      if (!hasPermissions) {
        this.logSvc.logInfo('Do not have permission to read active tab content');
      }

      // Depending on current perms, get full or partial page metadata
      return hasPermissions ? this.platformSvc.getPageMetadata(true) : this.platformSvc.getPageMetadata(false);
    });
  }

  clearNativeBookmarks(): ng.IPromise<void> {
    // Get native container ids
    return this.getNativeContainerIds()
      .then((nativeContainerIds) => {
        const otherBookmarksId = nativeContainerIds[BookmarkContainer.Other] as string;
        const toolbarBookmarksId = nativeContainerIds[BookmarkContainer.Toolbar] as string;

        // Clear other bookmarks
        const clearOthers = browser.bookmarks
          .getChildren(otherBookmarksId)
          .then((results) => {
            return this.$q.all(
              results.map((child) => {
                return this.removeNativeBookmarks(child.id);
              })
            );
          })
          .catch((err) => {
            this.logSvc.logWarning('Error clearing other bookmarks');
            throw err;
          });

        // Clear bookmarks toolbar if enabled
        const clearToolbar = this.bookmarkHelperSvc
          .getSyncBookmarksToolbar()
          .then((syncBookmarksToolbar) => {
            if (!syncBookmarksToolbar) {
              this.logSvc.logInfo('Not clearing toolbar');
              return;
            }

            return browser.bookmarks.getChildren(toolbarBookmarksId).then((results) => {
              return this.$q.all(
                results.map((child) => {
                  return this.removeNativeBookmarks(child.id);
                })
              );
            });
          })
          .catch((err) => {
            this.logSvc.logWarning('Error clearing bookmarks toolbar');
            throw err;
          });

        return this.$q.all([clearOthers, clearToolbar]).then(() => {});
      })
      .catch((err) => {
        throw new Exceptions.FailedRemoveNativeBookmarksException(null, err);
      });
  }

  convertNativeBookmarkToSeparator(
    bookmark: NativeBookmarks.BookmarkTreeNode
  ): ng.IPromise<NativeBookmarks.BookmarkTreeNode> {
    // Check if bookmark is in toolbar
    return this.isNativeBookmarkInToolbarContainer(bookmark).then((inToolbar) => {
      // Skip process if bookmark is not in toolbar and already native separator
      if (
        (bookmark.url === this.platformSvc.getNewTabUrl() &&
          !inToolbar &&
          bookmark.title === Globals.Bookmarks.HorizontalSeparatorTitle) ||
        (inToolbar && bookmark.title === Globals.Bookmarks.VerticalSeparatorTitle)
      ) {
        return bookmark;
      }

      // Disable event listeners and process conversion
      return this.disableEventListeners()
        .then(() => {
          const title = inToolbar
            ? Globals.Bookmarks.VerticalSeparatorTitle
            : Globals.Bookmarks.HorizontalSeparatorTitle;

          // If already a separator just update the title
          if (
            (!inToolbar && bookmark.title === Globals.Bookmarks.VerticalSeparatorTitle) ||
            (inToolbar && bookmark.title === Globals.Bookmarks.HorizontalSeparatorTitle)
          ) {
            return browser.bookmarks.update(bookmark.id, { title });
          }

          // Remove and recreate bookmark as a separator
          const separator: NativeBookmarks.CreateDetails = {
            index: bookmark.index,
            parentId: bookmark.parentId,
            title,
            url: this.platformSvc.getNewTabUrl()
          };
          return browser.bookmarks.remove(bookmark.id).then(() => {
            return browser.bookmarks.create(separator);
          });
        })
        .finally(this.enableEventListeners);
    });
  }

  countNativeContainersBeforeIndex(parentId: string, index: number): ng.IPromise<number> {
    // Get native container ids
    return this.getNativeContainerIds().then((nativeContainerIds) => {
      // No containers to adjust for if parent is not other bookmarks
      if (parentId !== nativeContainerIds[BookmarkContainer.Other]) {
        return 0;
      }

      // Get parent bookmark and count containers
      return browser.bookmarks.getSubTree(parentId).then((subTree) => {
        const numContainers = subTree[0].children.filter((child, childIndex) => {
          return childIndex < index && this.bookmarkHelperSvc.bookmarkIsContainer(child);
        }).length;
        return numContainers;
      });
    });
  }

  createBookmarkFromNativeBookmarkId(id: string, bookmarks: Bookmark[]): ng.IPromise<Bookmark> {
    return browser.bookmarks.get(id).then((results) => {
      if (!results || results.length === 0) {
        throw new Exceptions.NativeBookmarkNotFoundException();
      }
      const nativeBookmark = results[0];
      const convertedBookmark = this.bookmarkHelperSvc.convertNativeBookmarkToBookmark(nativeBookmark, bookmarks);
      return convertedBookmark;
    });
  }

  createNativeBookmark(
    parentId: string,
    title: string,
    url: string,
    index?: number
  ): ng.IPromise<NativeBookmarks.BookmarkTreeNode> {
    const nativeBookmarkInfo: NativeBookmarks.CreateDetails = {
      index,
      parentId,
      title
    };

    // Don't use unsupported urls for native bookmarks
    if (!angular.isUndefined(url)) {
      nativeBookmarkInfo.url = this.getSupportedUrl(url);
    }

    return browser.bookmarks.create(nativeBookmarkInfo).catch((err) => {
      this.logSvc.logWarning(`Failed to create native bookmark: ${JSON.stringify(nativeBookmarkInfo)}`);
      throw new Exceptions.FailedCreateNativeBookmarksException(null, err);
    });
  }

  createNativeBookmarksFromBookmarks(bookmarks: Bookmark[]): ng.IPromise<void> {
    const populateStartTime = new Date();

    // Get containers
    const menuContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Menu, bookmarks);
    const mobileContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Mobile, bookmarks);
    const otherContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Other, bookmarks);
    const toolbarContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Toolbar, bookmarks);

    // Get native container ids
    return this.getNativeContainerIds()
      .then((nativeContainerIds) => {
        const otherBookmarksId: string = nativeContainerIds[BookmarkContainer.Other];
        const toolbarBookmarksId: string = nativeContainerIds[BookmarkContainer.Toolbar];

        // Populate menu bookmarks in other bookmarks
        let populateMenu = this.$q.resolve();
        if (menuContainer) {
          populateMenu = browser.bookmarks
            .getSubTree(otherBookmarksId)
            .then(() => {
              return this.createNativeBookmarkTree(otherBookmarksId, [menuContainer], toolbarBookmarksId);
            })
            .catch((err) => {
              this.logSvc.logInfo('Error populating bookmarks menu.');
              throw err;
            });
        }

        // Populate mobile bookmarks in other bookmarks
        let populateMobile = this.$q.resolve();
        if (mobileContainer) {
          populateMobile = browser.bookmarks
            .getSubTree(otherBookmarksId)
            .then(() => {
              return this.createNativeBookmarkTree(otherBookmarksId, [mobileContainer], toolbarBookmarksId);
            })
            .catch((err) => {
              this.logSvc.logInfo('Error populating mobile bookmarks.');
              throw err;
            });
        }

        // Populate other bookmarks
        let populateOther = this.$q.resolve();
        if (otherContainer) {
          populateOther = browser.bookmarks
            .getSubTree(otherBookmarksId)
            .then(() => {
              return this.createNativeBookmarkTree(otherBookmarksId, otherContainer.children, toolbarBookmarksId);
            })
            .catch((err) => {
              this.logSvc.logInfo('Error populating other bookmarks.');
              throw err;
            });
        }

        // Populate bookmarks toolbar if enabled
        const populateToolbar = this.bookmarkHelperSvc.getSyncBookmarksToolbar().then((syncBookmarksToolbar) => {
          if (!syncBookmarksToolbar) {
            this.logSvc.logInfo('Not populating toolbar');
            return;
          }

          if (toolbarContainer) {
            return browser.bookmarks
              .getSubTree(toolbarBookmarksId)
              .then(() => {
                return this.createNativeBookmarkTree(toolbarBookmarksId, toolbarContainer.children);
              })
              .catch((err) => {
                this.logSvc.logInfo('Error populating bookmarks toolbar.');
                throw err;
              });
          }
        });

        return this.$q.all([populateMenu, populateMobile, populateOther, populateToolbar]);
      })
      .then(() => {
        this.logSvc.logInfo(`Bookmarks populated in ${((new Date() as any) - (populateStartTime as any)) / 1000}s`);
        // Move native unsupported containers into the correct order
        return this.reorderUnsupportedContainers();
      });
  }

  createNativeBookmarkTree(
    parentId: string,
    bookmarks: Bookmark[],
    nativeToolbarContainerId?: string
  ): ng.IPromise<void> {
    let processError: Error;
    const createRecursive = (id: string, bookmarksToCreate: Bookmark[], toolbarId: string) => {
      const createChildBookmarksPromises = [];

      // Create bookmarks at the top level of the supplied array
      return bookmarksToCreate
        .reduce((p, bookmark) => {
          return p.then(() => {
            // If an error occurred during the recursive process, prevent any more bookmarks being created
            if (processError) {
              return this.$q.resolve();
            }

            return this.bookmarkHelperSvc.isSeparator(bookmark)
              ? this.createNativeSeparator(id, toolbarId).then(() => {})
              : this.createNativeBookmark(id, bookmark.title, bookmark.url).then((newNativeBookmark) => {
                  // If the bookmark has children, recurse
                  if (bookmark.children && bookmark.children.length > 0) {
                    createChildBookmarksPromises.push(
                      createRecursive(newNativeBookmark.id, bookmark.children, toolbarId)
                    );
                  }
                });
          });
        }, this.$q.resolve())
        .then(() => {
          return this.$q.all(createChildBookmarksPromises);
        })
        .then(() => {})
        .catch((err) => {
          processError = err;
          throw err;
        });
    };
    return createRecursive(parentId, bookmarks, nativeToolbarContainerId);
  }

  createNativeSeparator(
    parentId: string,
    nativeToolbarContainerId: string
  ): ng.IPromise<NativeBookmarks.BookmarkTreeNode> {
    const newSeparator: NativeBookmarks.CreateDetails = {
      parentId,
      title:
        parentId === nativeToolbarContainerId
          ? Globals.Bookmarks.VerticalSeparatorTitle
          : Globals.Bookmarks.HorizontalSeparatorTitle,
      url: this.platformSvc.getNewTabUrl()
    };
    return browser.bookmarks.create(newSeparator).catch((err) => {
      this.logSvc.logInfo('Failed to create native separator');
      throw new Exceptions.FailedCreateNativeBookmarksException(null, err);
    });
  }

  disableEventListeners(): ng.IPromise<void> {
    return this.$q
      .all([
        browser.bookmarks.onCreated.removeListener(this.onNativeBookmarkCreated),
        browser.bookmarks.onRemoved.removeListener(this.onNativeBookmarkRemoved),
        browser.bookmarks.onChanged.removeListener(this.onNativeBookmarkChanged),
        browser.bookmarks.onMoved.removeListener(this.onNativeBookmarkMoved)
      ])
      .then(() => {})
      .catch((err) => {
        this.logSvc.logWarning('Failed to disable event listeners');
        throw new Exceptions.UnspecifiedException(null, err);
      });
  }

  enableEventListeners(): ng.IPromise<void> {
    return this.disableEventListeners()
      .then(() => {
        return this.storeSvc.get<boolean>(StoreKey.SyncEnabled);
      })
      .then((syncEnabled) => {
        if (!syncEnabled) {
          return;
        }
        browser.bookmarks.onCreated.addListener(this.onNativeBookmarkCreated);
        browser.bookmarks.onRemoved.addListener(this.onNativeBookmarkRemoved);
        browser.bookmarks.onChanged.addListener(this.onNativeBookmarkChanged);
        browser.bookmarks.onMoved.addListener(this.onNativeBookmarkMoved);
      })
      .catch((err) => {
        this.logSvc.logWarning('Failed to enable event listeners');
        throw new Exceptions.UnspecifiedException(null, err);
      });
  }

  getContainerNameFromNativeId(nativeBookmarkId: string): ng.IPromise<string> {
    return this.getNativeContainerIds().then((nativeContainerIds) => {
      const menuBookmarksId = nativeContainerIds[BookmarkContainer.Menu] as string;
      const mobileBookmarksId = nativeContainerIds[BookmarkContainer.Mobile] as string;
      const otherBookmarksId = nativeContainerIds[BookmarkContainer.Other] as string;
      const toolbarBookmarksId = nativeContainerIds[BookmarkContainer.Toolbar] as string;

      const nativeContainers = [
        { nativeId: otherBookmarksId, containerName: BookmarkContainer.Other },
        { nativeId: toolbarBookmarksId, containerName: BookmarkContainer.Toolbar }
      ];

      if (menuBookmarksId) {
        nativeContainers.push({ nativeId: menuBookmarksId, containerName: BookmarkContainer.Menu });
      }

      if (mobileBookmarksId) {
        nativeContainers.push({ nativeId: mobileBookmarksId, containerName: BookmarkContainer.Mobile });
      }

      // Check if the native bookmark id resolves to a container
      const result = nativeContainers.find((x) => x.nativeId === nativeBookmarkId);
      return result ? result.containerName : '';
    });
  }

  getNativeBookmarkByTitle(title: string): ng.IPromise<NativeBookmarks.BookmarkTreeNode> {
    if (!title) {
      return this.$q.resolve(null);
    }

    return browser.bookmarks.search({ title }).then((results) => {
      return results.shift();
    });
  }

  getNativeBookmarksAsBookmarks(): ng.IPromise<Bookmark[]> {
    let allNativeBookmarks = [];

    // Get native container ids
    return this.getNativeContainerIds()
      .then((nativeContainerIds) => {
        const menuBookmarksId: string = nativeContainerIds[BookmarkContainer.Menu];
        const mobileBookmarksId: string = nativeContainerIds[BookmarkContainer.Mobile];
        const otherBookmarksId: string = nativeContainerIds[BookmarkContainer.Other];
        const toolbarBookmarksId: string = nativeContainerIds[BookmarkContainer.Toolbar];

        // Get menu bookmarks
        const getMenuBookmarks =
          menuBookmarksId == null
            ? Promise.resolve<Bookmark[]>(null)
            : browser.bookmarks.getSubTree(menuBookmarksId).then((subTree) => {
                const menuBookmarks = subTree[0];
                if (menuBookmarks.children && menuBookmarks.children.length > 0) {
                  return this.bookmarkHelperSvc.getNativeBookmarksAsBookmarks(menuBookmarks.children);
                }
              });

        // Get mobile bookmarks
        const getMobileBookmarks =
          mobileBookmarksId == null
            ? Promise.resolve<Bookmark[]>(null)
            : browser.bookmarks.getSubTree(mobileBookmarksId).then((subTree) => {
                const mobileBookmarks = subTree[0];
                if (mobileBookmarks.children && mobileBookmarks.children.length > 0) {
                  return this.bookmarkHelperSvc.getNativeBookmarksAsBookmarks(mobileBookmarks.children);
                }
              });

        // Get other bookmarks
        const getOtherBookmarks =
          otherBookmarksId == null
            ? Promise.resolve<Bookmark[]>(null)
            : browser.bookmarks.getSubTree(otherBookmarksId).then((subTree) => {
                const otherBookmarks = subTree[0];
                if (!otherBookmarks.children || otherBookmarks.children.length === 0) {
                  return;
                }

                // Add all bookmarks into flat array
                this.bookmarkHelperSvc.eachBookmark(otherBookmarks.children, (bookmark) => {
                  allNativeBookmarks.push(bookmark);
                });

                // Remove any unsupported container folders present
                const bookmarksWithoutContainers = this.bookmarkHelperSvc
                  .getNativeBookmarksAsBookmarks(otherBookmarks.children)
                  .filter((x) => {
                    return !this.unsupportedContainers.find((y) => {
                      return y === x.title;
                    });
                  });
                return bookmarksWithoutContainers;
              });

        // Get toolbar bookmarks if enabled
        const getToolbarBookmarks =
          toolbarBookmarksId == null
            ? this.$q.resolve<Bookmark[]>(null)
            : this.$q
                .all([
                  this.bookmarkHelperSvc.getSyncBookmarksToolbar(),
                  browser.bookmarks.getSubTree(toolbarBookmarksId)
                ])
                .then((results) => {
                  const syncBookmarksToolbar = results[0];
                  const toolbarBookmarks = results[1][0];

                  if (!syncBookmarksToolbar) {
                    return;
                  }

                  if (toolbarBookmarks.children && toolbarBookmarks.children.length > 0) {
                    // Add all bookmarks into flat array
                    this.bookmarkHelperSvc.eachBookmark(toolbarBookmarks.children, (bookmark) => {
                      allNativeBookmarks.push(bookmark);
                    });

                    return this.bookmarkHelperSvc.getNativeBookmarksAsBookmarks(toolbarBookmarks.children);
                  }
                });

        return this.$q.all([getMenuBookmarks, getMobileBookmarks, getOtherBookmarks, getToolbarBookmarks]);
      })
      .then((results) => {
        const menuBookmarks = results[0];
        const mobileBookmarks = results[1];
        const otherBookmarks = results[2];
        const toolbarBookmarks = results[3];
        const bookmarks: Bookmark[] = [];
        let otherContainer: Bookmark;
        let toolbarContainer: Bookmark;
        let menuContainer: Bookmark;
        let mobileContainer: Bookmark;

        // Add other container if bookmarks present
        if (otherBookmarks && otherBookmarks.length > 0) {
          otherContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Other, bookmarks, true);
          otherContainer.children = otherBookmarks;
        }

        // Add toolbar container if bookmarks present
        if (toolbarBookmarks && toolbarBookmarks.length > 0) {
          toolbarContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Toolbar, bookmarks, true);
          toolbarContainer.children = toolbarBookmarks;
        }

        // Add menu container if bookmarks present
        if (menuBookmarks && menuBookmarks.length > 0) {
          menuContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Menu, bookmarks, true);
          menuContainer.children = menuBookmarks;
        }

        // Add mobile container if bookmarks present
        if (mobileBookmarks && mobileBookmarks.length > 0) {
          mobileContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Mobile, bookmarks, true);
          mobileContainer.children = mobileBookmarks;
        }

        // Filter containers from flat array of bookmarks
        [otherContainer, toolbarContainer, menuContainer, mobileContainer].forEach((container) => {
          if (!container) {
            return;
          }

          allNativeBookmarks = allNativeBookmarks.filter((bookmark) => {
            return bookmark.title !== container.title;
          });
        });

        // Sort by date added asc
        allNativeBookmarks = allNativeBookmarks.sort((x, y) => {
          return x.dateAdded - y.dateAdded;
        });

        // Iterate native bookmarks to add unique bookmark ids in correct order
        allNativeBookmarks.forEach((nativeBookmark) => {
          this.bookmarkHelperSvc.eachBookmark(bookmarks, (bookmark) => {
            if (
              !bookmark.id &&
              ((!nativeBookmark.url && bookmark.title === nativeBookmark.title) ||
                (nativeBookmark.url && bookmark.url === nativeBookmark.url))
            ) {
              bookmark.id = this.bookmarkHelperSvc.getNewBookmarkId(bookmarks);
            }
          });
        });

        // Find and fix any bookmarks missing ids
        this.bookmarkHelperSvc.eachBookmark(bookmarks, (bookmark) => {
          if (!bookmark.id) {
            bookmark.id = this.bookmarkHelperSvc.getNewBookmarkId(bookmarks);
          }
        });

        return bookmarks;
      });
  }

  getNativeContainerIds(): ng.IPromise<any> {
    return browser.bookmarks.getTree().then((tree) => {
      // Get the root child nodes
      const otherBookmarksNode = tree[0].children.find((x) => {
        return x.id === '2';
      });
      const toolbarBookmarksNode = tree[0].children.find((x) => {
        return x.id === '1';
      });

      // Throw an error if a native container node is not found
      if (!otherBookmarksNode || !toolbarBookmarksNode) {
        if (!otherBookmarksNode) {
          this.logSvc.logWarning('Missing container: other bookmarks');
        }
        if (!toolbarBookmarksNode) {
          this.logSvc.logWarning('Missing container: toolbar bookmarks');
        }
        throw new Exceptions.ContainerNotFoundException();
      }

      // Add containers to results
      const containerIds = {};
      containerIds[BookmarkContainer.Other] = otherBookmarksNode.id;
      containerIds[BookmarkContainer.Toolbar] = toolbarBookmarksNode.id;

      // Check for unsupported containers
      const menuBookmarksNode = otherBookmarksNode.children.find((x) => {
        return x.title === BookmarkContainer.Menu;
      });
      const mobileBookmarksNode = otherBookmarksNode.children.find((x) => {
        return x.title === BookmarkContainer.Mobile;
      });
      containerIds[BookmarkContainer.Menu] = menuBookmarksNode ? menuBookmarksNode.id : undefined;
      containerIds[BookmarkContainer.Mobile] = mobileBookmarksNode ? mobileBookmarksNode.id : undefined;

      return containerIds;
    });
  }

  getSupportedUrl(url: string): string {
    if (angular.isUndefined(url)) {
      return '';
    }

    // If url is not supported, use new tab url instead
    let returnUrl = url;
    if (!this.platformSvc.urlIsSupported(url)) {
      this.logSvc.logInfo(`Bookmark url unsupported: ${url}`);
      returnUrl = this.platformSvc.getNewTabUrl();
    }

    return returnUrl;
  }

  isNativeBookmarkInToolbarContainer(nativeBookmark: NativeBookmarks.BookmarkTreeNode): ng.IPromise<boolean> {
    return this.getNativeContainerIds().then((nativeContainerIds) => {
      return nativeBookmark.parentId === nativeContainerIds[BookmarkContainer.Toolbar];
    });
  }

  modifyNativeBookmark(id: string, newMetadata: BookmarkMetadata): ng.IPromise<NativeBookmarks.BookmarkTreeNode> {
    // Don't use unsupported urls for native bookmarks
    const updateInfo: NativeBookmarks.UpdateChangesType = {
      title: newMetadata.title
    };

    // Don't use unsupported urls for native bookmarks
    if (!angular.isUndefined(updateInfo.url)) {
      updateInfo.url = this.getSupportedUrl(updateInfo.url);
    }

    return browser.bookmarks.update(id, updateInfo).catch((err) => {
      this.logSvc.logInfo(`Failed to modify native bookmark: ${JSON.stringify(newMetadata)}`);
      throw new Exceptions.FailedUpdateNativeBookmarksException(null, err);
    });
  }

  onNativeBookmarkChanged(...args: any[]): void {
    this.logSvc.logInfo('onChanged event detected');
    this.queueNativeBookmarkEvent(BookmarkChangeType.Modify, ...args);
  }

  onNativeBookmarkCreated(...args: any[]): void {
    this.logSvc.logInfo('onCreated event detected');
    this.queueNativeBookmarkEvent(BookmarkChangeType.Add, ...args);
  }

  onNativeBookmarkMoved(...args: any[]): void {
    this.logSvc.logInfo('onMoved event detected');
    this.queueNativeBookmarkEvent(BookmarkChangeType.Move, ...args);
  }

  onNativeBookmarkRemoved(...args: any[]): void {
    this.logSvc.logInfo('onRemoved event detected');
    this.queueNativeBookmarkEvent(BookmarkChangeType.Remove, ...args);
  }

  processChangeOnBookmarks(changeInfo: BookmarkChange, bookmarks: Bookmark[]): ng.IPromise<Bookmark[]> {
    switch (changeInfo.type) {
      case BookmarkChangeType.Add:
        return this.processChangeTypeAddOnBookmarks(bookmarks, changeInfo.changeData as AddNativeBookmarkChangeData);
      case BookmarkChangeType.Modify:
        return this.processChangeTypeModifyOnBookmarks(
          bookmarks,
          changeInfo.changeData as ModifyNativeBookmarkChangeData
        );
      case BookmarkChangeType.Move:
        return this.processChangeTypeMoveOnBookmarks(bookmarks, changeInfo.changeData as MoveNativeBookmarkChangeData);
      case BookmarkChangeType.Remove:
        return this.processChangeTypeRemoveOnBookmarks(
          bookmarks,
          changeInfo.changeData as RemoveNativeBookmarkChangeData
        );
      default:
        throw new Exceptions.AmbiguousSyncRequestException();
    }
  }

  processChangeOnNativeBookmarks(
    id: number,
    changeType: BookmarkChangeType,
    changeInfo: BookmarkMetadata
  ): ng.IPromise<void> {
    // Check the change type and process native bookmark changes
    switch (changeType) {
      case BookmarkChangeType.Add:
        return this.processChangeTypeAddOnNativeBookmarks(id, changeInfo);
      case BookmarkChangeType.Modify:
        return this.processChangeTypeModifyOnNativeBookmarks(id, changeInfo);
      case BookmarkChangeType.Remove:
        return this.processChangeTypeRemoveOnNativeBookmarks(id);
      default:
        throw new Exceptions.AmbiguousSyncRequestException();
    }
  }

  processChangeTypeAddOnBookmarks(
    bookmarks: Bookmark[],
    changeData: AddNativeBookmarkChangeData
  ): ng.IPromise<Bookmark[]> {
    // Check if the current bookmark is a container
    return this.getContainerNameFromNativeId(changeData.nativeBookmark.parentId)
      .then((containerName) => {
        if (containerName) {
          // If parent is a container use it's id
          const container = this.bookmarkHelperSvc.getContainer(containerName, bookmarks, true);
          return container.id as number;
        }

        // Get the synced parent id from id mappings and retrieve the synced parent bookmark
        return this.bookmarkIdMapperSvc.get(changeData.nativeBookmark.parentId).then((idMapping) => {
          if (!idMapping) {
            // No mappings found, skip sync
            this.logSvc.logInfo('No id mapping found, skipping sync');
            return;
          }

          return idMapping.syncedId;
        });
      })
      .then((parentId) => {
        if (!parentId) {
          return;
        }

        // Add new bookmark then check if the change should be synced
        const newBookmarkMetadata = this.bookmarkHelperSvc.extractBookmarkMetadata(changeData.nativeBookmark);
        const addBookmarkResult = this.bookmarkHelperSvc.addBookmark(
          newBookmarkMetadata,
          parentId,
          changeData.nativeBookmark.index,
          bookmarks
        );
        return this.checkIfBookmarkChangeShouldBeSynced(addBookmarkResult.bookmark, addBookmarkResult.bookmarks).then(
          (syncChanges) => {
            if (!syncChanges) {
              // Don't sync this change
              return;
            }

            // Add new id mapping
            const idMapping = this.bookmarkIdMapperSvc.createMapping(
              addBookmarkResult.bookmark.id,
              changeData.nativeBookmark.id
            );
            return this.bookmarkIdMapperSvc.add(idMapping).then(() => {
              return addBookmarkResult.bookmarks;
            });
          }
        );
      });
  }

  processChangeTypeAddOnNativeBookmarks(id: number, createInfo: BookmarkMetadata): ng.IPromise<void> {
    // Create native bookmark in other bookmarks container
    return this.getNativeContainerIds()
      .then((nativeContainerIds) => {
        const otherBookmarksId = nativeContainerIds[BookmarkContainer.Other];
        return this.createNativeBookmark(otherBookmarksId, createInfo.title, createInfo.url);
      })
      .then((newNativeBookmark) => {
        // Add id mapping for new bookmark
        const idMapping = this.bookmarkIdMapperSvc.createMapping(id, newNativeBookmark.id);
        return this.bookmarkIdMapperSvc.add(idMapping);
      });
  }

  processChangeTypeModifyOnBookmarks(
    bookmarks: Bookmark[],
    changeData: ModifyNativeBookmarkChangeData
  ): ng.IPromise<Bookmark[]> {
    // Retrieve id mapping using native bookmark id from change data
    return this.bookmarkIdMapperSvc.get(changeData.nativeBookmark.id).then((idMapping) => {
      if (!idMapping) {
        // No mappings found, skip sync
        this.logSvc.logInfo('No id mapping found, skipping sync');
        return;
      }

      // Check if the change should be synced
      const bookmarkToUpdate = this.bookmarkHelperSvc.findBookmarkById(bookmarks, idMapping.syncedId) as Bookmark;
      return this.checkIfBookmarkChangeShouldBeSynced(bookmarkToUpdate, bookmarks).then((syncChange) => {
        if (!syncChange) {
          // Don't sync this change
          return;
        }

        // Modify the bookmark with the update info
        const updateInfo = this.bookmarkHelperSvc.extractBookmarkMetadata(changeData.nativeBookmark);
        return this.bookmarkHelperSvc.modifyBookmarkById(idMapping.syncedId, updateInfo, bookmarks);
      });
    });
  }

  processChangeTypeModifyOnNativeBookmarks(id: number, updateInfo: BookmarkMetadata): ng.IPromise<void> {
    // Retrieve native bookmark id from id mappings
    return this.bookmarkIdMapperSvc.get(null, id).then((idMapping) => {
      if (!idMapping) {
        this.logSvc.logWarning(`No id mapping found for synced id '${id}'`);
        return;
      }

      // Modify native bookmark
      return this.modifyNativeBookmark(idMapping.nativeId, updateInfo).then(() => {});
    });
  }

  processChangeTypeMoveOnBookmarks(
    bookmarks: Bookmark[],
    changeData: MoveNativeBookmarkChangeData
  ): ng.IPromise<Bookmark[]> {
    let changesMade = false;

    // Get the moved bookmark and new parent ids from id mappings or if container use the existing id
    return this.$q
      .all([
        this.bookmarkIdMapperSvc.get(changeData.id),
        this.getContainerNameFromNativeId(changeData.parentId).then((containerName) => {
          if (containerName) {
            const container = this.bookmarkHelperSvc.getContainer(containerName, bookmarks, true);
            return { syncedId: container.id };
          }
          return this.bookmarkIdMapperSvc.get(changeData.parentId);
        })
      ])
      .then((idMappings) => {
        if (!idMappings[0] && !idMappings[1]) {
          // No mappings found, skip sync
          this.logSvc.logInfo('No id mappings found, skipping sync');
          return;
        }

        // Get the bookmark to be removed
        // If no mapping exists then native bookmark will likely have been
        //  created in toolbar container whilst not syncing toolbar option enabled
        //  in which case create a new bookmark from the native bookmark
        return (!idMappings[0]
          ? this.createBookmarkFromNativeBookmarkId(changeData.id, bookmarks)
          : this.$q.resolve(this.bookmarkHelperSvc.findBookmarkById(bookmarks, idMappings[0].syncedId) as Bookmark)
        ).then((bookmarkToRemove) => {
          // If old parent is mapped, remove the moved bookmark
          let removeBookmarkPromise: ng.IPromise<Bookmark[]>;
          if (!idMappings[0]) {
            // Moved bookmark not mapped, skip remove
            removeBookmarkPromise = this.$q.resolve(bookmarks);
          } else {
            // Check if change should be synced then remove the bookmark
            removeBookmarkPromise = this.checkIfBookmarkChangeShouldBeSynced(bookmarkToRemove, bookmarks).then(
              (syncChange) => {
                if (!syncChange) {
                  // Don't sync this change, return unmodified bookmarks
                  return bookmarks;
                }
                return this.bookmarkHelperSvc
                  .removeBookmarkById(idMappings[0].syncedId, bookmarks)
                  .then((updatedBookmarks) => {
                    // Set flag to ensure update bookmarks are synced
                    changesMade = true;
                    return updatedBookmarks;
                  });
              }
            );
          }
          return removeBookmarkPromise
            .then((bookmarksAfterRemoval) => {
              let addBookmarkPromise: ng.IPromise<Bookmark[]>;
              if (!idMappings[1]) {
                // New parent not mapped, skip add
                addBookmarkPromise = this.$q.resolve(bookmarksAfterRemoval);
              } else {
                // Add the bookmark then check if change should be synced
                addBookmarkPromise = this.countNativeContainersBeforeIndex(changeData.parentId, changeData.index).then(
                  (numContainers) => {
                    // Adjust the target index by the number of container folders then add the bookmark
                    const index = changeData.index - numContainers;
                    const bookmarkMetadata = this.bookmarkHelperSvc.extractBookmarkMetadata(bookmarkToRemove);
                    const addBookmarkResult = this.bookmarkHelperSvc.addBookmark(
                      bookmarkMetadata,
                      idMappings[1].syncedId,
                      index,
                      bookmarksAfterRemoval
                    );
                    addBookmarkResult.bookmark.id = bookmarkToRemove.id;
                    return this.checkIfBookmarkChangeShouldBeSynced(
                      addBookmarkResult.bookmark,
                      addBookmarkResult.bookmarks
                    ).then((syncChange) => {
                      if (!syncChange) {
                        // Don't sync this change, return bookmarks after removal processed
                        return bookmarksAfterRemoval;
                      }

                      // Set flag to ensure update bookmarks are synced
                      changesMade = true;

                      // Add new id mapping for moved bookmark
                      if (idMappings[0]) {
                        // If moved bookmark was already mapped, no need to update id mappings
                        return addBookmarkResult.bookmarks;
                      }
                      const idMapping = this.bookmarkIdMapperSvc.createMapping(
                        addBookmarkResult.bookmark.id,
                        changeData.id
                      );
                      return this.bookmarkIdMapperSvc.add(idMapping).then(() => {
                        return addBookmarkResult.bookmarks;
                      });
                    });
                  }
                );
              }
              return addBookmarkPromise;
            })
            .then((updatedBookmarks) => {
              if (!changesMade) {
                // No changes made, skip sync
                return;
              }
              return updatedBookmarks;
            });
        });
      });
  }

  processChangeTypeRemoveOnBookmarks(
    bookmarks: Bookmark[],
    changeData: RemoveNativeBookmarkChangeData
  ): ng.IPromise<Bookmark[]> {
    // Check if the removed bookmark was an unsupported container
    const isContainer =
      this.unsupportedContainers.filter((x) => {
        return x === changeData.nativeBookmark.title;
      }).length > 0;
    if (isContainer) {
      throw new Exceptions.ContainerChangedException();
    }

    // Get the synced bookmark id from change data
    return this.bookmarkIdMapperSvc.get(changeData.nativeBookmark.id).then((idMapping) => {
      if (!idMapping) {
        // No mappings found, skip sync
        this.logSvc.logInfo('No id mapping found, skipping sync');
        return;
      }

      // Check if the change should be synced
      const bookmarkToRemove = this.bookmarkHelperSvc.findBookmarkById(bookmarks, idMapping.syncedId) as Bookmark;
      return this.checkIfBookmarkChangeShouldBeSynced(bookmarkToRemove, bookmarks).then((syncChange) => {
        if (!syncChange) {
          // Don't sync this change
          return;
        }

        // Get all child bookmark mappings
        const descendantsIds = this.bookmarkHelperSvc.getIdsFromDescendants(bookmarkToRemove);

        // Remove bookmark
        return this.bookmarkHelperSvc.removeBookmarkById(idMapping.syncedId, bookmarks).then((updatedBookmarks) => {
          // Remove all retrieved ids from mappings
          const syncedIds = descendantsIds.concat([idMapping.syncedId]);
          return this.bookmarkIdMapperSvc.remove(syncedIds).then(() => {
            return updatedBookmarks;
          });
        });
      });
    });
  }

  processChangeTypeRemoveOnNativeBookmarks(id: number): ng.IPromise<void> {
    // Get native bookmark id from id mappings
    return this.bookmarkIdMapperSvc.get(null, id).then((idMapping) => {
      if (!idMapping) {
        this.logSvc.logWarning(`No id mapping found for synced id '${id}'`);
        return;
      }

      // Remove bookmark and id mapping
      return this.removeNativeBookmarks(idMapping.nativeId).then(() => {
        return this.bookmarkIdMapperSvc.remove(id);
      });
    });
  }

  processNativeBookmarkEventsQueue(): void {
    const doActionUntil = (): ng.IPromise<boolean> => {
      return this.$q.resolve(this.nativeBookmarkEventsQueue.length === 0);
    };

    const action = (): any => {
      // Get first event in the queue and process change
      const currentEvent = this.nativeBookmarkEventsQueue.shift();
      switch (currentEvent.changeType) {
        case BookmarkChangeType.Add:
          return this.syncNativeBookmarkCreated(...currentEvent.eventArgs);
        case BookmarkChangeType.Remove:
          return this.syncNativeBookmarkRemoved(...currentEvent.eventArgs);
        case BookmarkChangeType.Move:
          return this.syncNativeBookmarkMoved(...currentEvent.eventArgs);
        case BookmarkChangeType.Modify:
          return this.syncNativeBookmarkChanged(...currentEvent.eventArgs);
        default:
          throw new Exceptions.AmbiguousSyncRequestException();
      }
    };

    // Iterate through the queue and process the events
    this.utilitySvc.promiseWhile(this.nativeBookmarkEventsQueue, doActionUntil, action).then(() => {
      this.$timeout(() => {
        this.syncEngineService.executeSync().then(() => {
          // Move native unsupported containers into the correct order
          return this.disableEventListeners().then(this.reorderUnsupportedContainers).then(this.enableEventListeners);
        });
      }, 100);
    });
  }

  queueNativeBookmarkEvent(changeType: BookmarkChangeType, ...eventArgs: any[]): void {
    // Clear timeout
    if (this.processNativeBookmarkEventsTimeout) {
      this.$timeout.cancel(this.processNativeBookmarkEventsTimeout);
    }

    // Add event to the queue and trigger processing after a delay
    this.nativeBookmarkEventsQueue.push({
      changeType,
      eventArgs
    });
    this.processNativeBookmarkEventsTimeout = this.$timeout(this.processNativeBookmarkEventsQueue, 200);
  }

  removeNativeBookmarks(id: string): ng.IPromise<void> {
    return browser.bookmarks.removeTree(id).catch((err) => {
      this.logSvc.logInfo(`Failed to remove native bookmark: ${id}`);
      throw new Exceptions.FailedRemoveNativeBookmarksException(null, err);
    });
  }

  reorderUnsupportedContainers(): ng.IPromise<void> {
    // Get unsupported containers
    return this.$q.all(this.unsupportedContainers.map(this.getNativeBookmarkByTitle)).then((results) => {
      return this.$q
        .all(
          results
            // Remove falsy results
            .filter((x) => x)
            // Reorder each native bookmark to top of parent
            .map((container, index) => {
              return browser.bookmarks.move(container.id, {
                index,
                parentId: container.parentId
              });
            })
        )
        .then(() => {});
    });
  }

  syncChange(changeInfo: BookmarkChange): ng.IPromise<any> {
    const sync: Sync = {
      changeInfo,
      type: SyncType.Remote
    };

    // Queue sync but dont execute sync to allow for batch processing multiple changes
    return this.platformSvc.sync_Queue(sync, MessageCommand.SyncBookmarks, false).catch(() => {
      // Swallow error, sync errors thrown searately by processBookmarkEventsQueue
    });
  }

  syncNativeBookmarkChanged(id?: string): ng.IPromise<void> {
    // Retrieve full bookmark info
    return browser.bookmarks.getSubTree(id).then((results) => {
      const changedBookmark = results[0];

      // If bookmark is separator update native bookmark properties
      (this.bookmarkHelperSvc.isSeparator(changedBookmark)
        ? this.convertNativeBookmarkToSeparator(changedBookmark)
        : this.$q.resolve(changedBookmark)
      ).then((bookmarkNode) => {
        // If the bookmark was converted to a separator, update id mapping
        let updateMappingPromise: ng.IPromise<void>;
        if (bookmarkNode.id !== id) {
          updateMappingPromise = this.bookmarkIdMapperSvc.get(id).then((idMapping) => {
            if (!idMapping) {
              throw new Exceptions.BookmarkMappingNotFoundException();
            }

            return this.bookmarkIdMapperSvc.remove(idMapping.syncedId).then(() => {
              const newMapping = this.bookmarkIdMapperSvc.createMapping(idMapping.syncedId, bookmarkNode.id);
              return this.bookmarkIdMapperSvc.add(newMapping);
            });
          });
        } else {
          updateMappingPromise = this.$q.resolve();
        }
        return updateMappingPromise.then(() => {
          // Create change info
          const data: ModifyNativeBookmarkChangeData = {
            nativeBookmark: bookmarkNode
          };
          const changeInfo: BookmarkChange = {
            changeData: data,
            type: BookmarkChangeType.Modify
          };

          // Queue sync
          this.syncChange(changeInfo);
        });
      });
    });
  }

  syncNativeBookmarkCreated(id?: string, nativeBookmark?: NativeBookmarks.BookmarkTreeNode): ng.IPromise<void> {
    // If bookmark is separator update native bookmark properties
    return (this.bookmarkHelperSvc.isSeparator(nativeBookmark)
      ? this.convertNativeBookmarkToSeparator(nativeBookmark)
      : this.$q.resolve(nativeBookmark)
    ).then((bookmarkNode) => {
      // Create change info
      const data: AddNativeBookmarkChangeData = {
        nativeBookmark: bookmarkNode
      };
      const changeInfo: BookmarkChange = {
        changeData: data,
        type: BookmarkChangeType.Add
      };

      // If bookmark is not folder or separator, get page metadata from current tab
      return (bookmarkNode.url && !this.bookmarkHelperSvc.isSeparator(bookmarkNode)
        ? this.checkPermsAndGetPageMetadata()
        : this.$q.resolve<WebpageMetadata>(null)
      ).then((metadata) => {
        // Add metadata if bookmark is current tab location
        if (metadata && bookmarkNode.url === metadata.url) {
          (changeInfo.changeData as AddNativeBookmarkChangeData).nativeBookmark.title = this.utilitySvc.stripTags(
            metadata.title
          );
          (changeInfo.changeData as AddNativeBookmarkChangeData).nativeBookmark.description = this.utilitySvc.stripTags(
            metadata.description
          );
          (changeInfo.changeData as AddNativeBookmarkChangeData).nativeBookmark.tags = this.utilitySvc.getTagArrayFromText(
            metadata.tags
          );
        }

        // Queue sync
        this.syncChange(changeInfo);
      });
    });
  }

  syncNativeBookmarkMoved(id?: string, moveInfo?: NativeBookmarks.OnMovedMoveInfoType): ng.IPromise<void> {
    return browser.bookmarks.get(id).then((results) => {
      const movedBookmark = results[0];

      // If bookmark is separator update native bookmark properties
      return (this.bookmarkHelperSvc.isSeparator(movedBookmark)
        ? this.convertNativeBookmarkToSeparator(movedBookmark)
        : this.$q.resolve(movedBookmark)
      ).then((bookmarkNode) => {
        // If the bookmark was converted to a separator, update id mapping
        let updateMappingPromise: ng.IPromise<void>;
        if (bookmarkNode.id !== id) {
          updateMappingPromise = this.bookmarkIdMapperSvc.get(id).then((idMapping) => {
            if (!idMapping) {
              throw new Exceptions.BookmarkMappingNotFoundException();
            }

            return this.bookmarkIdMapperSvc.remove(idMapping.syncedId).then(() => {
              const newMapping = this.bookmarkIdMapperSvc.createMapping(idMapping.syncedId, bookmarkNode.id);
              return this.bookmarkIdMapperSvc.add(newMapping);
            });
          });
        } else {
          updateMappingPromise = this.$q.resolve();
        }
        return updateMappingPromise.then(() => {
          // Create change info
          const data: MoveNativeBookmarkChangeData = {
            ...moveInfo,
            id
          };
          const changeInfo: BookmarkChange = {
            changeData: data,
            type: BookmarkChangeType.Move
          };

          // Queue sync
          this.syncChange(changeInfo);
        });
      });
    });
  }

  syncNativeBookmarkRemoved(id?: string, removeInfo?: NativeBookmarks.OnRemovedRemoveInfoType): ng.IPromise<void> {
    // Create change info
    const data: RemoveNativeBookmarkChangeData = {
      nativeBookmark: removeInfo.node
    };
    const changeInfo: BookmarkChange = {
      changeData: data,
      type: BookmarkChangeType.Remove
    };

    // Queue sync
    this.syncChange(changeInfo);
    return this.$q.resolve();
  }

  wasContainerChanged(changedBookmark: Bookmark, bookmarks: Bookmark[]): ng.IPromise<boolean> {
    return (bookmarks ? this.$q.resolve(bookmarks) : this.bookmarkHelperSvc.getCachedBookmarks()).then((results) => {
      bookmarks = results;

      // Check based on title
      if (this.bookmarkHelperSvc.bookmarkIsContainer(changedBookmark)) {
        return true;
      }

      // Get native container ids
      return this.getNativeContainerIds().then((nativeContainerIds) => {
        // If parent is other bookmarks, check other bookmarks children for containers
        const otherBookmarksId = nativeContainerIds[BookmarkContainer.Other];
        // TODO: check if native bookmarks are passed here (parentId)
        if ((changedBookmark as any).parentId !== otherBookmarksId) {
          return false;
        }

        return browser.bookmarks
          .getChildren(otherBookmarksId)
          .then((children) => {
            // Get all native bookmarks in other bookmarks that are unsupported containers
            const containers = children.filter((x) => {
              return this.unsupportedContainers.find((y) => {
                return y === x.title;
              });
            });
            let containersCount = 0;
            let checksFailed = false;
            let count;

            // Check each container present only appears once
            const menuContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Menu, bookmarks, false);
            if (menuContainer) {
              containersCount += 1;
              count = containers.filter((x) => {
                return x.title === BookmarkContainer.Menu;
              }).length;
              checksFailed = count !== 1 ? true : checksFailed;
            }

            const mobileContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Mobile, bookmarks, false);
            if (mobileContainer) {
              containersCount += 1;
              count = containers.filter((x) => {
                return x.title === BookmarkContainer.Mobile;
              }).length;
              checksFailed = count !== 1 ? true : checksFailed;
            }

            // Check number of containers match and return result
            checksFailed = containersCount !== containers.length ? true : checksFailed;
            return checksFailed;
          })
          .catch((err) => {
            this.logSvc.logInfo(`Failed to detect whether container changed: ${JSON.stringify(changedBookmark)}`);
            throw new Exceptions.FailedGetNativeBookmarksException(null, err);
          });
      });
    });
  }
}
