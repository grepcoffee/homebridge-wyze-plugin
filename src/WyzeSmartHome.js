const { homebridge, Accessory, UUIDGen } = require('./types')
const { OutdoorPlugModels, PlugModels, CommonModels, CameraModels, LeakSensorModels,
  TemperatureHumidityModels, LockModels, LockBoltV2Models, MotionSensorModels, ContactSensorModels, LightModels,
  LightStripModels, MeshLightModels, ThermostatModels, S1GatewayModels } = require('./enums')

const WyzeAPI = require('wyze-api') // Uncomment for Release
//const WyzeAPI = require('./wyze-api/src') // Comment for Release
const WyzePlug = require('./accessories/WyzePlug')
const WyzeLight = require('./accessories/WyzeLight')
const WyzeMeshLight = require('./accessories/WyzeMeshLight')
const WyzeLock = require('./accessories/WyzeLock')
const WyzeLockBoltV2 = require('./accessories/WyzeLockBoltV2')
const WyzeContactSensor = require('./accessories/WyzeContactSensor')
const WyzeMotionSensor = require('./accessories/WyzeMotionSensor')
const WyzeTemperatureHumidity = require('./accessories/WyzeTemperatureHumidity')
const WyzeLeakSensor = require('./accessories/WyzeLeakSensor')
const WyzeCamera = require('./accessories/WyzeCamera')
const WyzeSwitch = require('./accessories/WyzeSwitch')
const WyzeHMS = require('./accessories/WyzeHMS')
const WyzeThermostat = require('./accessories/WyzeThermostat')

const PLUGIN_NAME = 'homebridge-wyze-smart-home'
const PLATFORM_NAME = 'WyzeSmartHome'

const DEFAULT_REFRESH_INTERVAL = 30000
const MIN_REFRESH_INTERVAL = 30000
const OUTDOOR_PLUG_MODEL_SET = new Set(Object.values(OutdoorPlugModels))
const PLUG_MODEL_SET = new Set(Object.values(PlugModels))
const COMMON_MODEL_SET = new Set(Object.values(CommonModels))
const CAMERA_MODEL_SET = new Set(Object.values(CameraModels))
const LEAK_SENSOR_MODEL_SET = new Set(Object.values(LeakSensorModels))
const TEMPERATURE_HUMIDITY_MODEL_SET = new Set(Object.values(TemperatureHumidityModels))
const LOCK_MODEL_SET = new Set(Object.values(LockModels))
const LOCK_BOLT_V2_MODEL_SET = new Set(Object.values(LockBoltV2Models))
const MOTION_SENSOR_MODEL_SET = new Set(Object.values(MotionSensorModels))
const CONTACT_SENSOR_MODEL_SET = new Set(Object.values(ContactSensorModels))
const LIGHT_MODEL_SET = new Set(Object.values(LightModels))
const LIGHT_STRIP_MODEL_SET = new Set(Object.values(LightStripModels))
const MESH_LIGHT_MODEL_SET = new Set(Object.values(MeshLightModels))
const THERMOSTAT_MODEL_SET = new Set(Object.values(ThermostatModels))
const S1_GATEWAY_MODEL_SET = new Set(Object.values(S1GatewayModels))
const SECRET_KEYS = [
  'password',
  'apiKey',
  'keyId',
  'mfaCode',
  'authApiKey',
  'fordAppKey',
  'fordAppSecret',
  'oliveSigningSecret',
  'oliveAppId',
  'source',
  'stillImageSource'
]

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = class WyzeSmartHome {
  constructor(log, config, api) {
    this.config = config || {}
    this.log = this.createSecureLogger(log)
    this.api = api
    this.refreshInterval = Math.max(this.config.refreshInterval || DEFAULT_REFRESH_INTERVAL, MIN_REFRESH_INTERVAL)
    this.filterByMacAddressSet = new Set(this.config.filterByMacAddressList || [])
    this.filterDeviceTypeSet = new Set(this.config.filterDeviceTypeList || [])
    this.cameraStreamByMac = new Map((this.config.cameraStreams || [])
      .filter(stream => stream.mac && stream.source)
      .map(stream => [stream.mac, stream]))
    this.client = this.getClient()

    this.accessories = []
    this.accessoriesByMac = new Map()
    this.stopped = false

    this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this))
    this.api.on('shutdown', this.shutdown.bind(this))
  }

  static register() {
    homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, WyzeSmartHome)
  }

  getClient() {
    return new WyzeAPI({
      // User login parameters
      username: this.config.username,
      password: this.config.password,
      mfaCode: this.config.mfaCode,
      keyId: this.config.keyId,
      apiKey: this.config.apiKey,
      //Logging
      apiLogEnabled: this.config.apiLogEnabled,
      //App Config
      lowBatteryPercentage: this.config.lowBatteryPercentage,
      //Storage Path
      persistPath: homebridge.user.persistPath(),
      //URLs
      authBaseUrl: this.config.authBaseUrl,
      apiBaseUrl: this.config.apiBaseUrl,
      // App emulation constants
      authApiKey: this.config.authApiKey,
      phoneId: this.config.phoneId,
      appName: this.config.appName,
      appVer: this.config.appVer,
      appVersion: this.config.appVersion,
      userAgent: this.config.userAgent,
      sc: this.config.sc,
      sv: this.config.sv,
      // Crypto Secrets
      fordAppKey: this.config.fordAppKey, // Required for Locks
      fordAppSecret: this.config.fordAppSecret, // Required for Locks
      oliveSigningSecret: this.config.oliveSigningSecret, // Required for the thermostat
      oliveAppId: this.config.oliveAppId, //  Required for the thermostat
      appInfo: this.config.appInfo // Required for the thermostat
    }, this.log)
  }

  didFinishLaunching() {
    this.runLoop()
  }

  shutdown() {
    this.stopped = true
  }

  async runLoop() {
    while (!this.stopped) {
      try {
        await this.refreshDevices()
      } catch (e) {
        if (this.config.pluginLoggingEnabled) this.log.error(`Refresh failed: ${e}`)
      }

      await delay(this.refreshInterval)
    }
  }

  async refreshDevices() {
    if (this.config.pluginLoggingEnabled) this.log('Refreshing devices...')

    try {
      const objectList = await this.client.getObjectList()
      const timestamp = objectList.ts
      const devices = objectList.data.device_list || []

      if (this.config.pluginLoggingEnabled) this.log(`Found ${devices.length} device(s)`)
      await this.loadDevices(devices, timestamp)
    } catch (e) {
      this.log.error(`Error getting devices: ${e}`)
      throw e
    }
  }

  async loadDevices(devices, timestamp) {
    const foundAccessories = []

    for (const device of devices) {
      const accessory = await this.loadDevice(device, timestamp)
      if (accessory) {
        foundAccessories.push(accessory)
      }
    }

    const foundAccessorySet = new Set(foundAccessories)
    const removedAccessories = this.accessories.filter(a => !foundAccessorySet.has(a))
    if (removedAccessories.length > 0) {
      if (this.config.pluginLoggingEnabled) this.log(`Removing ${removedAccessories.length} device(s)`)
      const removedHomeKitAccessories = removedAccessories.map(a => a.homeKitAccessory)
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removedHomeKitAccessories)
    }

    this.accessories = foundAccessories
    this.accessoriesByMac = new Map(foundAccessories.map(accessory => [accessory.mac, accessory]))
  }

  async loadDevice(device, timestamp) {
    const accessoryClass = this.getAccessoryClass(device.product_type, device.product_model, device.mac, device.nickname)
    if (!accessoryClass) {
      if (this.config.pluginLoggingEnabled) this.log(`[${device.product_type}] Unsupported device type: (Name: ${device.nickname}) (MAC: ${device.mac}) (Model: ${device.product_model})`)
      return
    }
    else if (this.filterByMacAddressSet.has(device.mac) || this.filterDeviceTypeSet.has(device.product_type)) {
      if (this.config.pluginLoggingEnabled) this.log(`[${device.product_type}] Ignoring (${device.nickname}) (MAC: ${device.mac}) because it is in the Ignore Device list`)
      return
    }
    else if (device.product_type == 'S1Gateway' && this.config.hms == false) {
      if (this.config.pluginLoggingEnabled) this.log(`[${device.product_type}] Ignoring (${device.nickname}) (MAC: ${device.mac}) because it is not enabled`)
      return
    }


    let accessory = this.accessoriesByMac.get(device.mac)
    if (!accessory) {
      const homeKitAccessory = this.createHomeKitAccessory(device)
      accessory = new accessoryClass(this, homeKitAccessory)
      this.accessories.push(accessory)
      this.accessoriesByMac.set(device.mac, accessory)
    } else {
      if (this.config.pluginLoggingEnabled) this.log(`[${device.product_type}] Loading accessory from cache ${device.nickname} (MAC: ${device.mac})`)
    }
    accessory.update(device, timestamp)

    return accessory
  }

  getAccessoryClass(type, model) {
    switch (type) {
      case 'OutdoorPlug':
        if (OUTDOOR_PLUG_MODEL_SET.has(model)) { return WyzePlug }
      case 'Plug':
        if (PLUG_MODEL_SET.has(model)) { return WyzePlug }
      case 'Light':
        if (LIGHT_MODEL_SET.has(model)) { return WyzeLight }
      case 'MeshLight':
        if (MESH_LIGHT_MODEL_SET.has(model)) { return WyzeMeshLight }
      case 'LightStrip':
        if (LIGHT_STRIP_MODEL_SET.has(model)) { return WyzeMeshLight }
      case 'ContactSensor':
        if (CONTACT_SENSOR_MODEL_SET.has(model)) { return WyzeContactSensor }
      case 'MotionSensor':
        if (MOTION_SENSOR_MODEL_SET.has(model)) { return WyzeMotionSensor }
      case 'Lock':
        if (LOCK_MODEL_SET.has(model)) { return WyzeLock }
      case 'TemperatureHumidity':
        if (TEMPERATURE_HUMIDITY_MODEL_SET.has(model)) { return WyzeTemperatureHumidity }
      case 'LeakSensor':
        if (LEAK_SENSOR_MODEL_SET.has(model)) { return WyzeLeakSensor }
      case 'Camera':
        if (CAMERA_MODEL_SET.has(model)) { return WyzeCamera }
      case 'Common':
        if (LOCK_BOLT_V2_MODEL_SET.has(model)) { return WyzeLockBoltV2 }
        if (COMMON_MODEL_SET.has(model)) { return WyzeSwitch }
      case 'S1Gateway':
        if (S1_GATEWAY_MODEL_SET.has(model)) { return WyzeHMS }
      case 'Thermostat':
        if (THERMOSTAT_MODEL_SET.has(model)) { return WyzeThermostat }
    }
  }

  createHomeKitAccessory(device) {
    const uuid = UUIDGen.generate(device.mac)

    const homeKitAccessory = new Accessory(device.nickname, uuid)

    homeKitAccessory.context = {
      mac: device.mac,
      product_type: device.product_type,
      product_model: device.product_model,
      nickname: device.nickname
    }

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [homeKitAccessory])
    return homeKitAccessory
  }

  getCameraStreamConfig(mac) {
    return this.cameraStreamByMac.get(mac)
  }

  createSecureLogger(log) {
    const write = message => log(this.sanitizeLog(message))
    for (const level of ['debug', 'info', 'warn', 'error']) {
      if (typeof log[level] === 'function') {
        write[level] = message => log[level](this.sanitizeLog(message))
      }
    }
    return write
  }

  sanitizeLog(value) {
    let message = value instanceof Error ? value.stack || value.message : String(value)

    for (const key of SECRET_KEYS) {
      const secret = this.config[key]
      if (typeof secret === 'string' && secret.length > 3) {
        message = message.split(secret).join('[REDACTED]')
      }
    }

    for (const stream of this.config.cameraStreams || []) {
      for (const key of ['source', 'stillImageSource']) {
        if (typeof stream[key] === 'string' && stream[key].length > 3) {
          message = message.split(stream[key]).join('[REDACTED_URL]')
        }
      }
    }

    return message
      .replace(/((?:rtsp|rtsps|http|https):\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
      .replace(/((?:password|apiKey|keyId|token|secret)\s*[:=]\s*)[^\s,}]+/gi, '$1[REDACTED]')
  }

  // Homebridge calls this method on boot to reinitialize previously-discovered devices
  configureAccessory(homeKitAccessory) {
    // Make sure we haven't set up this accessory already
    let accessory = this.accessoriesByMac.get(homeKitAccessory.context.mac)
    if (accessory) {
      return
    }

    const accessoryClass = this.getAccessoryClass(homeKitAccessory.context.product_type, homeKitAccessory.context.product_model)
    if (accessoryClass) {
      accessory = new accessoryClass(this, homeKitAccessory)
      this.accessories.push(accessory)
      this.accessoriesByMac.set(accessory.mac, accessory)
    } else {
      try {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [homeKitAccessory])
      } catch (error) {
        this.log.error(`Error removing accessory ${homeKitAccessory.context.nickname} (MAC: ${homeKitAccessory.context.mac}) : ${error}`)
      }
    }
  }
}
