import Controller from '@ember/controller';
import { action } from '@ember/object';

import debug from 'debug';
const log = debug('ember-rpi:app:controller');

export default class ApplicationController extends Controller {
  isLEDOn = false;

  @action
  toggleLED() {
    log(`toggleLED: isLEDOn=${this.isLEDOn}`);
    this.set('isLEDOn', !this.isLEDOn); // TODO: Do we need to .set in Octane?
  }
}
