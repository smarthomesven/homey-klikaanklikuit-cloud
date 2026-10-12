'use strict';

const Homey = require('homey');
const { DEVICE_TYPES } = require('../../lib/KakuApi');

class SocketSwitchDriver extends Homey.Driver {
  async onPair(session) {
    const api = this.homey.app.api;

    session.setHandler('login', async (data) => {
      try {
        await api.login(data.email, data.password);
        await session.showView('list_devices');
        return true;
      } catch (err) {
        this.error('Login error:', err.message);
        return false;
      }
    });

    session.setHandler('list_devices', async () => {
      const devices = [];
      for (const homeId of api.homeIds()) {
        for (const m of await api.listModules(homeId)) {
          if (DEVICE_TYPES[m.device] !== 'socket-switch') {
            // virtual modules (P1, Alarm, IPCam, Geofencing, System) and unsupported device types
            this.log(`Skipping module ${m.id} "${m.name}" (device code ${m.device})`);
            continue;
          }
          devices.push({ name: m.name, data: { id: m.id, home_id: homeId } });
        }
      }
      return devices;
    });
  }
}

module.exports = SocketSwitchDriver;