'use strict';

const Homey = require('homey');

const FN_ONLINE = 0;
const FN_ONOFF = 3;

class PlugDevice extends Homey.Device {
  async onInit() {
    const { id, home_id: homeId } = this.getData();
    const api = this.homey.app.api;

    this.registerCapabilityListener('onoff', async (value) => {
      await api.setFunction(homeId, id, FN_ONOFF, value ? 1 : 0);
      api.poll();
    });

    this._unsubscribe = api.subscribe(homeId, id, async (functions) => {
      this.setCapabilityValue('onoff', functions[FN_ONOFF] === 1).catch(this.error);
      if (functions[FN_ONLINE] === 0) {
        await this.setUnavailable();
      } else {
        await this.setAvailable();
      }
    });
  }

  async onUninit() {
    if (this._unsubscribe) this._unsubscribe();
  }
}

module.exports = PlugDevice;