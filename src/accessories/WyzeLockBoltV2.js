const axios = require("axios");
const crypto = require("crypto");
const { Service, Characteristic } = require("../types");
const WyzeAccessory = require("./WyzeAccessory");

const IOT3_APP_HOST = "https://app.wyzecam.com";
const IOT3_GET_PROPERTY_PATH = "/app/v4/iot3/get-property";
const IOT3_RUN_ACTION_PATH = "/app/v4/iot3/run-action";
const OLIVE_SIGNING_SECRET = "wyze_app_secret_key_132";
const OLIVE_APP_ID = "9319141212m2ik";
const OLIVE_APP_INFO = "wyze_android_3.11.0.758";

const noResponse = new Error("No Response");
noResponse.toString = () => {
  return noResponse.message;
};

module.exports = class WyzeLockBoltV2 extends WyzeAccessory {
  constructor(plugin, homeKitAccessory) {
    super(plugin, homeKitAccessory);

    this.isLocked = true;
    this.isDoorOpen = false;
    this.batteryLevel = 100;

    if (this.plugin.config.pluginLoggingEnabled)
      this.plugin.log(
        `[LockBoltV2] Retrieving previous service for "${this.display_name} (${this.mac})"`
      );
    this.lockService = this.homeKitAccessory.getService(Service.LockMechanism);

    if (this.plugin.config.pluginLoggingEnabled)
      this.plugin.log(
        `[LockBoltV2] [Door Contact] Retrieving previous service for "${this.display_name} (${this.mac})"`
      );
    this.contactService = this.homeKitAccessory.getService(Service.ContactSensor);

    if (this.plugin.config.pluginLoggingEnabled)
      this.plugin.log(
        `[LockBoltV2] [Battery] Retrieving previous service for "${this.display_name} (${this.mac})"`
      );
    this.batteryService = this.homeKitAccessory.getService(Service.Battery);

    if (!this.lockService) {
      if (this.plugin.config.pluginLoggingEnabled)
        this.plugin.log(
          `[LockBoltV2] Adding service for "${this.display_name} (${this.mac})"`
        );
      this.lockService = this.homeKitAccessory.addService(Service.LockMechanism);
    }

    if (!this.contactService) {
      if (this.plugin.config.pluginLoggingEnabled)
        this.plugin.log(
          `[LockBoltV2] [Door Contact] Adding service for "${this.display_name} (${this.mac})"`
        );
      this.contactService = this.homeKitAccessory.addService(Service.ContactSensor);
    }

    if (!this.batteryService) {
      if (this.plugin.config.pluginLoggingEnabled)
        this.plugin.log(
          `[LockBoltV2] [Battery] Adding service for "${this.display_name} (${this.mac})"`
        );
      this.batteryService = this.homeKitAccessory.addService(Service.Battery);
    }

    this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .onGet(this.getBatteryLevel.bind(this));

    this.batteryService
      .getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(this.getLowBatteryStatus.bind(this));

    this.contactService
      .getCharacteristic(Characteristic.ContactSensorState)
      .onGet(this.getDoorStatus.bind(this));

    this.lockService
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(this.getLockCurrentState.bind(this));

    this.lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(this.getLockTargetState.bind(this))
      .onSet(this.setLockTargetState.bind(this));
  }

  _computeSignature(bodyStr) {
    const accessKey = this.plugin.client.access_token + OLIVE_SIGNING_SECRET;
    const secret = crypto.createHash("md5").update(accessKey).digest("hex");
    return crypto.createHmac("md5", secret).update(bodyStr).digest("hex");
  }

  _buildHeaders(bodyStr) {
    return {
      access_token: this.plugin.client.access_token,
      appid: OLIVE_APP_ID,
      appinfo: OLIVE_APP_INFO,
      appversion: "3.11.0.758",
      env: "Prod",
      phoneid: this.plugin.client.phoneId,
      requestid: crypto.randomBytes(16).toString("hex"),
      Signature2: this._computeSignature(bodyStr),
      "Content-Type": "application/json; charset=utf-8",
    };
  }

  _extractModel(deviceMac) {
    const parts = deviceMac.split("_");
    if (parts.length >= 3) {
      return parts.slice(0, 2).join("_");
    }
    return deviceMac;
  }

  async _iot3Post(path, payload) {
    const body = JSON.stringify(payload);
    const headers = this._buildHeaders(body);
    const response = await axios.post(`${IOT3_APP_HOST}${path}`, body, { headers });
    return response.data;
  }

  async _getProperties() {
    const ts = Date.now();
    const payload = {
      nonce: String(ts),
      payload: {
        cmd: "get_property",
        props: [
          "lock::lock-status",
          "lock::door-status",
          "iot-device::iot-state",
          "battery::battery-level",
          "battery::power-source",
          "device-info::firmware-ver",
        ],
        tid: Math.floor(Math.random() * 89000) + 10000,
        ts,
        ver: 1,
      },
      targetInfo: {
        id: this.mac,
        model: this._extractModel(this.mac),
      },
    };
    return this._iot3Post(IOT3_GET_PROPERTY_PATH, payload);
  }

  async _runAction(action) {
    const ts = Date.now();
    const payload = {
      nonce: String(ts),
      payload: {
        action,
        cmd: "run_action",
        params: {
          action_id: Math.floor(Math.random() * 89999) + 10000,
          type: 1,
          username: this.plugin.client.username,
        },
        tid: Math.floor(Math.random() * 89000) + 10000,
        ts,
        ver: 1,
      },
      targetInfo: {
        id: this.mac,
        model: this._extractModel(this.mac),
      },
    };
    return this._iot3Post(IOT3_RUN_ACTION_PATH, payload);
  }

  async updateCharacteristics(device) {
    if (device.conn_state === 0) {
      if (this.plugin.config.pluginLoggingEnabled)
        this.plugin.log(
          `[LockBoltV2] Updating status "${this.display_name} (${this.mac}) to noResponse"`
        );
      this.lockService
        .getCharacteristic(Characteristic.LockCurrentState)
        .updateValue(noResponse);
      return;
    }

    if (this.plugin.config.pluginLoggingEnabled)
      this.plugin.log(
        `[LockBoltV2] Updating status of "${this.display_name} (${this.mac})"`
      );

    try {
      const result = await this._getProperties();
      if (result.code !== "1") {
        if (this.plugin.config.pluginLoggingEnabled)
          this.plugin.log(
            `[LockBoltV2] IoT3 error for "${this.display_name} (${this.mac})": ${result.msg}`
          );
        return;
      }

      const props = (result.data && result.data.props) || {};

      if (props["lock::lock-status"] !== undefined) {
        this.isLocked = props["lock::lock-status"];
        this.lockService
          .getCharacteristic(Characteristic.LockCurrentState)
          .updateValue(
            this.isLocked
              ? Characteristic.LockCurrentState.SECURED
              : Characteristic.LockCurrentState.UNSECURED
          );
        this.lockService
          .getCharacteristic(Characteristic.LockTargetState)
          .updateValue(
            this.isLocked
              ? Characteristic.LockTargetState.SECURED
              : Characteristic.LockTargetState.UNSECURED
          );
      }

      if (props["lock::door-status"] !== undefined) {
        // door-status: true = door closed, false = door open
        this.isDoorOpen = !props["lock::door-status"];
        this.contactService
          .getCharacteristic(Characteristic.ContactSensorState)
          .updateValue(
            this.isDoorOpen
              ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : Characteristic.ContactSensorState.CONTACT_DETECTED
          );
      }

      if (props["battery::battery-level"] !== undefined) {
        this.batteryLevel = props["battery::battery-level"];
        this.batteryService
          .getCharacteristic(Characteristic.BatteryLevel)
          .updateValue(this.plugin.client.checkBatteryVoltage(this.batteryLevel));
        this.batteryService
          .getCharacteristic(Characteristic.StatusLowBattery)
          .updateValue(
            this.plugin.client.checkLowBattery(this.batteryLevel)
          );
      }
    } catch (e) {
      if (this.plugin.config.pluginLoggingEnabled)
        this.plugin.log(
          `[LockBoltV2] Error updating "${this.display_name} (${this.mac})": ${e}`
        );
    }
  }

  async getLockCurrentState() {
    if (this.plugin.config.pluginLoggingEnabled)
      this.plugin.log(
        `[LockBoltV2] Getting Current State "${this.display_name} (${this.mac}) to ${this.isLocked}"`
      );
    return this.isLocked
      ? Characteristic.LockCurrentState.SECURED
      : Characteristic.LockCurrentState.UNSECURED;
  }

  async getLockTargetState() {
    if (this.plugin.config.pluginLoggingEnabled)
      this.plugin.log(
        `[LockBoltV2] Getting Target State "${this.display_name} (${this.mac}) to ${this.isLocked}"`
      );
    return this.isLocked
      ? Characteristic.LockTargetState.SECURED
      : Characteristic.LockTargetState.UNSECURED;
  }

  async getDoorStatus() {
    if (this.plugin.config.pluginLoggingEnabled)
      this.plugin.log(
        `[LockBoltV2] Getting Door Status "${this.display_name} (${this.mac}) to ${this.isDoorOpen}"`
      );
    return this.isDoorOpen
      ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  async getBatteryLevel() {
    if (this.plugin.config.pluginLoggingEnabled)
      this.plugin.log(
        `[LockBoltV2] Getting Battery Level "${this.display_name} (${this.mac}) to ${this.batteryLevel}"`
      );
    return this.plugin.client.checkBatteryVoltage(this.batteryLevel);
  }

  async getLowBatteryStatus() {
    if (this.plugin.config.pluginLoggingEnabled)
      this.plugin.log(
        `[LockBoltV2] Getting Low Battery Status "${this.display_name} (${this.mac}) to ${this.plugin.client.checkLowBattery(this.batteryLevel)}"`
      );
    return this.plugin.client.checkLowBattery(this.batteryLevel);
  }

  async setLockTargetState(targetState) {
    if (this.plugin.config.pluginLoggingEnabled)
      this.plugin.log(
        `[LockBoltV2] Setting Target State "${this.display_name} (${this.mac}) to ${targetState}"`
      );

    const action =
      targetState === Characteristic.LockTargetState.SECURED
        ? "lock::lock"
        : "lock::unlock";

    try {
      const result = await this._runAction(action);
      if (result.code !== "1") {
        if (this.plugin.config.pluginLoggingEnabled)
          this.plugin.log(
            `[LockBoltV2] Command failed for "${this.display_name} (${this.mac})": ${result.msg}`
          );
        return;
      }
      this.isLocked = targetState === Characteristic.LockTargetState.SECURED;
      this.lockService.setCharacteristic(
        Characteristic.LockCurrentState,
        this.isLocked
          ? Characteristic.LockCurrentState.SECURED
          : Characteristic.LockCurrentState.UNSECURED
      );
    } catch (e) {
      if (this.plugin.config.pluginLoggingEnabled)
        this.plugin.log(
          `[LockBoltV2] Error setting lock "${this.display_name} (${this.mac})": ${e}`
        );
    }
  }
};
