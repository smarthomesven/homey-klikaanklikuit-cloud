'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const { KakuApi } = require('./lib/KakuApi');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyApp has been initialized');
    if (!this.homey.settings.get('unique_id')) {
      const uniqueId = crypto.randomUUID();
      this.homey.settings.set('unique_id', uniqueId);
      this.log('Generating new ID:', uniqueId);
    } else {
      this.log('Using ID:', this.homey.settings.get('unique_id'));
    }
    this.api = new KakuApi(this.homey);

  }

};
