import { Component, OnInit } from 'angular-ts-decorators';
import autobind from 'autobind-decorator';
import { PlatformService } from '../../shared/global-shared.interface';
import { StoreKey } from '../../shared/store/store.enum';
import { StoreService } from '../../shared/store/store.service';
import { UtilityService } from '../../shared/utility/utility.service';
import { KeyCode, RoutePath } from '../app.enum';
import { AppHelperService } from '../shared/app-helper/app-helper.service';
import { HelpRouteParams } from './app-help.interface';

@autobind
@Component({
  controllerAs: 'vm',
  selector: 'appHelp',
  styles: [require('./app-help.component.scss')],
  template: require('./app-help.component.html')
})
export class AppHelpComponent implements OnInit {
  Strings = require('../../../../res/strings/en.json');

  $location: ng.ILocationService;
  $routeParams: ng.route.IRouteParamsService;
  $timeout: ng.ITimeoutService;
  appHelperSvc: AppHelperService;
  platformSvc: PlatformService;
  storeSvc: StoreService;
  utilitySvc: UtilityService;

  currentPage = 0;
  pages: string[];
  showPage = false;

  static $inject = [
    '$location',
    '$routeParams',
    '$timeout',
    'AppHelperService',
    'PlatformService',
    'StoreService',
    'UtilityService'
  ];
  constructor(
    $location: ng.ILocationService,
    $routeParams: ng.route.IRouteParamsService,
    $timeout: ng.ITimeoutService,
    AppHelperSvc: AppHelperService,
    PlatformSvc: PlatformService,
    StoreSvc: StoreService,
    UtilitySvc: UtilityService
  ) {
    this.$location = $location;
    this.$routeParams = $routeParams;
    this.$timeout = $timeout;
    this.appHelperSvc = AppHelperSvc;
    this.platformSvc = PlatformSvc;
    this.storeSvc = StoreSvc;
    this.utilitySvc = UtilitySvc;
  }

  close(event: Event): void {
    this.utilitySvc.stopEventPropagation(event);
    this.storeSvc.set(StoreKey.DisplayHelp, false).then(() => this.appHelperSvc.switchView());
  }

  displayPage(pageToDisplay = 0, event: Event): void {
    this.utilitySvc.stopEventPropagation(event);
    if (pageToDisplay <= 0 || pageToDisplay > this.pages.length) {
      return this.close(event);
    }
    this.$location.path(`${RoutePath.Help}/${pageToDisplay}`);
  }

  displayNextPage(event: Event): void {
    this.displayPage(this.currentPage + 1, event);
  }

  displayPreviousPage(event: Event): void {
    this.displayPage(this.currentPage - 1, event);
  }

  handleKeyDown(event: KeyboardEvent): void {
    switch (event.keyCode) {
      case KeyCode.Escape:
        event.preventDefault();
        this.appHelperSvc.switchView();
        break;
      case KeyCode.ArrowLeft:
        this.displayPreviousPage(event);
        break;
      case KeyCode.ArrowRight:
        this.displayNextPage(event);
        break;
      default:
    }
  }

  ngOnInit(): void {
    // Load help pages and display first page
    this.pages = this.appHelperSvc.getHelpPages();
    this.currentPage = parseInt((this.$routeParams as HelpRouteParams).id, 10);
    this.$timeout(() => {
      this.showPage = true;

      // Focus on relevant link and set links to open in new tabs
      this.appHelperSvc.focusOnElement('.focused:not(.ng-hide)');
      this.appHelperSvc.attachClickEventsToNewTabLinks();
    });
  }
}
