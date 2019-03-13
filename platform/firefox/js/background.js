var xBrowserSync = xBrowserSync || {};
xBrowserSync.App = xBrowserSync.App || {};

/* ------------------------------------------------------------------------------------
 * Class name:	xBrowserSync.App.Background
 * Description:	Initialises Firefox background required functionality; registers events; 
 *              listens for sync requests.
 * ------------------------------------------------------------------------------------ */

xBrowserSync.App.Background = function ($q, platform, globals, utility, bookmarks) {
  'use strict';

  var vm;

	/* ------------------------------------------------------------------------------------
	 * Constructor
	 * ------------------------------------------------------------------------------------ */

  var Background = function () {
    vm = this;
    vm.install = onInstallHandler;
    vm.startup = onStartupHandler;
    browser.runtime.onMessage.addListener(onMessageHandler);
    browser.alarms.onAlarm.addListener(onAlarmHandler);
  };


	/* ------------------------------------------------------------------------------------
	 * Private functions
	 * ------------------------------------------------------------------------------------ */

  var changeBookmark = function (id, changeInfo) {
    utility.LogInfo('onChanged event detected');
    return $q(function (resolve, reject) {
      syncBookmarks({
        type: globals.SyncType.Push,
        changeInfo: {
          type: globals.UpdateType.Update,
          data: [id, changeInfo]
        }
      }, function (response) {
        if (response.success) {
          resolve(response.bookmarks);
        }
        else {
          reject(response.error);
        }
      });
    });
  };

  var createBookmark = function (id, bookmark) {
    utility.LogInfo('onCreated event detected');

    // Get page metadata from current tab if permission has been granted
    return platform.GetPageMetadata(true)
      .then(function (metadata) {
        // Add metadata if bookmark is current tab location
        if (metadata && bookmark.url === metadata.url) {
          bookmark.title = utility.StripTags(metadata.title);
          bookmark.description = utility.StripTags(metadata.description);
          bookmark.tags = utility.GetTagArrayFromText(metadata.tags);
        }

        return $q(function (resolve, reject) {
          syncBookmarks({
            type: globals.SyncType.Push,
            changeInfo: {
              type: globals.UpdateType.Create,
              data: [id, bookmark]
            }
          }, function (response) {
            if (response.success) {
              resolve(response.bookmarks);
            }
            else {
              reject(response.error);
            }
          });
        });
      });
  };

  var disableEventListeners = function (sendResponse) {
    sendResponse = sendResponse || function () { };
    var response = {
      success: true
    };

    try {
      browser.bookmarks.onCreated.removeListener(onCreatedHandler);
      browser.bookmarks.onRemoved.removeListener(onRemovedHandler);
      browser.bookmarks.onChanged.removeListener(onChangedHandler);
      browser.bookmarks.onMoved.removeListener(onMovedHandler);
    }
    catch (err) {
      utility.LogInfo('Failed to disable event listeners');
      response.error = err;
      response.success = false;
    }

    sendResponse(response);
  };

  var displayAlert = function (title, message, callback) {
    var options = {
      type: 'basic',
      title: title,
      message: message,
      iconUrl: 'img/notification.png'
    };

    if (!callback) {
      callback = null;
    }

    browser.notifications.create('xBrowserSync-notification', options, callback);
  };

  var enableEventListeners = function (sendResponse) {
    sendResponse = sendResponse || function () { };
    var response = {
      success: true
    };

    $q(function (resolve, reject) {
      disableEventListeners(function (disableResponse) {
        if (disableResponse.success) {
          resolve();
        }
        else {
          reject(disableResponse.error);
        }
      });
    })
      .then(function () {
        browser.bookmarks.onCreated.addListener(onCreatedHandler);
        browser.bookmarks.onRemoved.addListener(onRemovedHandler);
        browser.bookmarks.onChanged.addListener(onChangedHandler);
        browser.bookmarks.onMoved.addListener(onMovedHandler);
      })
      .catch(function (err) {
        utility.LogInfo('Failed to enable event listeners');
        response.error = err;
        response.success = false;
      })
      .finally(function () {
        sendResponse(response);
      });
  };

  var getCurrentSync = function (sendResponse) {
    try {
      sendResponse({
        currentSync: bookmarks.GetCurrentSync(),
        success: true
      });
    }
    catch (err) { }
  };

  var getLatestUpdates = function () {
    // Exit if currently syncing
    var currentSync = bookmarks.GetCurrentSync();
    if (currentSync) {
      return $q.resolve();
    }

    // Exit if sync not enabled
    return platform.LocalStorage.Get(globals.CacheKeys.SyncEnabled)
      .then(function (syncEnabled) {
        if (!syncEnabled) {
          return;
        }

        return bookmarks.CheckForUpdates()
          .then(function (updatesAvailable) {
            if (!updatesAvailable) {
              return;
            }

            utility.LogInfo('Updates found, retrieving latest sync data');

            // Get bookmark updates
            return $q(function (resolve, reject) {
              syncBookmarks({
                type: globals.SyncType.Pull
              }, function (response) {
                if (response.success) {
                  resolve(response.bookmarks);
                }
                else {
                  reject(response.error);
                }
              });
            });
          });
      });
  };

  var installExtension = function (currentVersion) {
    // Clear trace log and display permissions panel if not already dismissed
    return platform.LocalStorage.Set(globals.CacheKeys.TraceLog)

      // TODO: Add this back once Firefox supports optional permissions
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1533014

      //  return platform.LocalStorage.Set(globals.CacheKeys.DisplayPermissions, true)
      //})
      .then(function () {
        return utility.LogInfo('Installed v' + currentVersion);
      });
  };

  var moveBookmark = function (id, moveInfo) {
    utility.LogInfo('onMoved event detected');
    return $q(function (resolve, reject) {
      syncBookmarks({
        type: globals.SyncType.Push,
        changeInfo: {
          type: globals.UpdateType.Move,
          data: [id, moveInfo]
        }
      }, function (response) {
        if (response.success) {
          resolve(response.bookmarks);
        }
        else {
          reject(response.error);
        }
      });
    });
  };

  var onAlarmHandler = function (alarm) {
    // When alarm fires check for sync updates
    if (alarm && alarm.name === globals.Alarm.Name) {
      getLatestUpdates()
        .catch(function (err) {
          // Don't display alert if sync failed due to network connection
          if (err.code === globals.ErrorCodes.HttpRequestFailed ||
            err.code === globals.ErrorCodes.HttpRequestFailedWhileUpdating) {
            return;
          }

          utility.LogError(err, 'background.onAlarmHandler');

          // If ID was removed disable sync
          if (err.code === globals.ErrorCodes.NoDataFound) {
            err.code = globals.ErrorCodes.SyncRemoved;
            bookmarks.DisableSync();
          }

          // Display alert
          var errMessage = utility.GetErrorMessageFromException(err);
          displayAlert(errMessage.title, errMessage.message);
        });
    }
  };

  var onBookmarkEventHandler = function (syncFunction, args) {
    return syncFunction.apply(this, args)
      .catch(function (err) {
        // Display alert
        var errMessage = utility.GetErrorMessageFromException(err);
        displayAlert(errMessage.title, errMessage.message);
      });
  };

  var onChangedHandler = function () {
    onBookmarkEventHandler(changeBookmark, arguments);
  };

  var onCreatedHandler = function () {
    onBookmarkEventHandler(createBookmark, arguments);
  };

  var onInstallHandler = function (details) {
    var currentVersion = browser.runtime.getManifest().version;
    var installOrUpgrade = $q.resolve();

    // Check for upgrade or do fresh install
    if (details && details.reason === 'update' &&
      details.previousVersion && details.previousVersion !== currentVersion) {
      installOrUpgrade = upgradeExtension(details.previousVersion, currentVersion);
    }
    else {
      installOrUpgrade = installExtension(currentVersion);
    }

    // Run startup process after install/upgrade
    installOrUpgrade.then(onStartupHandler);
  };

  var onMessageHandler = function (message, sender, sendResponse) {
    switch (message.command) {
      // Trigger bookmarks sync
      case globals.Commands.SyncBookmarks:
        syncBookmarks(message, sendResponse);
        break;
      // Trigger bookmarks restore
      case globals.Commands.RestoreBookmarks:
        restoreBookmarks(message, sendResponse);
        break;
      // Get current sync in progress
      case globals.Commands.GetCurrentSync:
        getCurrentSync(sendResponse);
        break;
      // Enable event listeners
      case globals.Commands.EnableEventListeners:
        enableEventListeners(sendResponse);
        break;
      // Disable event listeners
      case globals.Commands.DisableEventListeners:
        disableEventListeners(sendResponse);
        break;
      // Unknown command
      default:
        var err = new Error('Unknown command: ' + message.command);
        utility.LogError(err, 'background.onMessageHandler');
        sendResponse({ success: false, error: err });
    }

    // Enable async response
    return true;
  };

  var onMovedHandler = function () {
    onBookmarkEventHandler(moveBookmark, arguments);
  };

  var onRemovedHandler = function () {
    onBookmarkEventHandler(removeBookmark, arguments);
  };

  var onStartupHandler = function () {
    var cachedData, syncEnabled;

    $q.all([
      platform.LocalStorage.Get(),
      platform.LocalStorage.Set(globals.CacheKeys.TraceLog)
    ])
      .then(function (data) {
        cachedData = data[0];
        syncEnabled = cachedData[globals.CacheKeys.SyncEnabled];
        return utility.LogInfo('Starting up');
      })
      .then(function () {
        cachedData.appVersion = globals.AppVersion;
        return utility.LogInfo(_.omit(
          cachedData,
          'debugMessageLog',
          globals.CacheKeys.Bookmarks,
          globals.CacheKeys.TraceLog,
          globals.CacheKeys.Password
        ));
      })
      .then(function () {
        // Refresh interface
        platform.Interface.Refresh(syncEnabled);

        // Exit if sync not enabled
        if (!syncEnabled) {
          return;
        }

        // Enable event listeners
        return $q(function (resolve, reject) {
          enableEventListeners(function (response) {
            if (response.success) {
              resolve();
            }
            else {
              reject(response.error);
            }
          });
        })
          // Start auto updates
          .then(platform.AutomaticUpdates.Start)
          // Check for updates to synced bookmarks
          .then(bookmarks.CheckForUpdates)
          .then(function (updatesAvailable) {
            if (!updatesAvailable) {
              return;
            }

            utility.LogInfo('Updates found, retrieving latest sync data');

            return $q(function (resolve, reject) {
              syncBookmarks({
                type: globals.SyncType.Pull
              }, function (response) {
                if (response.success) {
                  resolve(response.bookmarks);
                }
                else {
                  reject(response.error);
                }
              });
            });
          })
          .catch(function (err) {
            // Display alert
            var errMessage = utility.GetErrorMessageFromException(err);
            displayAlert(errMessage.title, errMessage.message);

            // Don't log error if request failed
            if (err.code === globals.ErrorCodes.HttpRequestFailed) {
              return;
            }

            utility.LogError(err, 'background.onStartupHandler');
          });
      });
  };

  var removeBookmark = function (id, removeInfo) {
    utility.LogInfo('onRemoved event detected');
    return $q(function (resolve, reject) {
      syncBookmarks({
        type: globals.SyncType.Push,
        changeInfo: {
          type: globals.UpdateType.Delete,
          data: [id, removeInfo]
        }
      }, function (response) {
        if (response.success) {
          resolve(response.bookmarks);
        }
        else {
          reject(response.error);
        }
      });
    });
  };

  var restoreBookmarks = function (restoreData, sendResponse) {
    sendResponse = sendResponse || function () { };

    return $q(function (resolve, reject) {
      disableEventListeners(function (response) {
        if (response.success) {
          resolve();
        }
        else {
          reject(response.error);
        }
      });
    })
      .then(function () {
        // Upgrade containers to use current container names
        var upgradedBookmarks = bookmarks.UpgradeContainers(restoreData.bookmarks || []);

        // If bookmarks don't have unique ids, add new ids
        if (!bookmarks.CheckBookmarksHaveUniqueIds(upgradedBookmarks)) {
          return platform.Bookmarks.AddIds(upgradedBookmarks)
            .then(function (updatedBookmarks) {
              return updatedBookmarks;
            });
        }
        else {
          return upgradedBookmarks;
        }
      })
      .then(function (bookmarksToRestore) {
        restoreData.bookmarks = bookmarksToRestore;
        return syncBookmarks(restoreData, sendResponse);
      });
  };

  var syncBookmarks = function (syncData, sendResponse) {
    sendResponse = sendResponse || function () { };

    // Disable event listeners if sync will affect local bookmarks
    var checkEventListeners = syncData.type === globals.SyncType.Pull || syncData.type === globals.SyncType.Both ?
      $q(function (resolve, reject) {
        disableEventListeners(function (response) {
          if (response.success) {
            resolve();
          }
          else {
            reject(response.error);
          }
        });
      }) :
      $q.resolve();

    return checkEventListeners
      .then(function () {
        // Start sync
        return bookmarks.Sync(syncData)
          .catch(function (err) {
            // If local data out of sync, queue refresh sync
            if (err && err.code === globals.ErrorCodes.DataOutOfSync) {
              return syncBookmarks({ type: globals.SyncType.Pull })
                .then(function () {
                  utility.LogInfo('Local sync data refreshed');
                  return $q.reject(err);
                });
            }

            return $q.reject(err);
          });
      })
      .then(function (bookmarks) {
        try {
          sendResponse({ bookmarks: bookmarks, success: true });
        }
        catch (err) { }

        // Send a message in case the user closed the extension window
        browser.runtime.sendMessage({
          command: globals.Commands.SyncFinished,
          success: true,
          uniqueId: syncData.uniqueId
        })
          .catch(function () { });
      })
      .catch(function (err) {
        try {
          sendResponse({ error: err, success: false });
        }
        catch (err2) { }

        // Send a message in case the user closed the extension window
        browser.runtime.sendMessage({
          command: globals.Commands.SyncFinished,
          error: err,
          success: false
        })
          .catch(function () { });
      })
      // Enable event listeners if required
      .finally(toggleEventListeners);
  };

  var toggleEventListeners = function () {
    return platform.LocalStorage.Get(globals.CacheKeys.SyncEnabled)
      .then(function (syncEnabled) {
        return $q(function (resolve, reject) {
          var callback = function (response) {
            if (response.success) {
              resolve();
            }
            else {
              reject(response.error);
            }
          };

          if (syncEnabled) {
            return enableEventListeners(callback);
          }
          else {
            return disableEventListeners(callback);
          }
        });
      });
  };

  var upgradeExtension = function (oldVersion, newVersion) {
    return platform.LocalStorage.Set(globals.CacheKeys.TraceLog)
      .then(function () {
        utility.LogInfo('Upgrading from ' + oldVersion + ' to ' + newVersion);
      })
      .then(function () {
        // For v1.5.0, convert local storage items to storage API
        if (newVersion === '1.5.0' && compareVersions(oldVersion, newVersion) < 0) {
          return utility.ConvertLocalStorageToStorageApi();
        }
      })
      .then(function () {
        // Set update panel to show
        return platform.LocalStorage.Set(globals.CacheKeys.DisplayUpdated, true);
      })
      .catch(function (err) {
        utility.LogError(err, 'background.upgradeExtension');

        // Display alert
        var errMessage = utility.GetErrorMessageFromException(err);
        displayAlert(errMessage.title, errMessage.message);
      });
  };

  // Call constructor
  return new Background();
};

// Initialise the angular app
xBrowserSync.App.FirefoxBackground = angular.module('xBrowserSync.App.FirefoxBackground', []);

// Disable debug info
xBrowserSync.App.FirefoxBackground.config(['$compileProvider', function ($compileProvider) {
  $compileProvider.debugInfoEnabled(false);
}]);

// Add platform service
xBrowserSync.App.Platform.$inject = ['$q'];
xBrowserSync.App.FirefoxBackground.factory('platform', xBrowserSync.App.Platform);

// Add global service
xBrowserSync.App.Global.$inject = ['platform'];
xBrowserSync.App.FirefoxBackground.factory('globals', xBrowserSync.App.Global);

// Add httpInterceptor service
xBrowserSync.App.HttpInterceptor.$inject = ['$q', 'globals'];
xBrowserSync.App.FirefoxBackground.factory('httpInterceptor', xBrowserSync.App.HttpInterceptor);
xBrowserSync.App.FirefoxBackground.config(['$httpProvider', function ($httpProvider) {
  $httpProvider.interceptors.push('httpInterceptor');
}]);

// Add utility service
xBrowserSync.App.Utility.$inject = ['$q', 'platform', 'globals'];
xBrowserSync.App.FirefoxBackground.factory('utility', xBrowserSync.App.Utility);

// Add api service
xBrowserSync.App.API.$inject = ['$http', '$q', 'platform', 'globals', 'utility'];
xBrowserSync.App.FirefoxBackground.factory('api', xBrowserSync.App.API);

// Add bookmarks service
xBrowserSync.App.Bookmarks.$inject = ['$q', '$timeout', 'platform', 'globals', 'api', 'utility'];
xBrowserSync.App.FirefoxBackground.factory('bookmarks', xBrowserSync.App.Bookmarks);

// Add platform implementation service
xBrowserSync.App.PlatformImplementation.$inject = ['$interval', '$q', '$timeout', 'platform', 'globals', 'utility', 'bookmarks'];
xBrowserSync.App.FirefoxBackground.factory('platformImplementation', xBrowserSync.App.PlatformImplementation);

// Add background module
xBrowserSync.App.Background.$inject = ['$q', 'platform', 'globals', 'utility', 'bookmarks', 'platformImplementation'];
xBrowserSync.App.FirefoxBackground.controller('Controller', xBrowserSync.App.Background);

// Set synchronous event handlers
browser.runtime.onInstalled.addListener(function () {
  document.querySelector('#install').click();
});
browser.runtime.onStartup.addListener(function () {
  document.querySelector('#startup').click();
});