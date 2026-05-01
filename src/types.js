const types = {}

module.exports = types

module.exports.update = function (homebridge) {
  types.homebridge = homebridge
  types.Accessory = homebridge.platformAccessory
  types.Service = homebridge.hap.Service
  types.Characteristic = homebridge.hap.Characteristic
  types.CameraController = homebridge.hap.CameraController
  types.SRTPCryptoSuites = homebridge.hap.SRTPCryptoSuites
  types.H264Profile = homebridge.hap.H264Profile
  types.H264Level = homebridge.hap.H264Level
  types.AudioStreamingCodecType = homebridge.hap.AudioStreamingCodecType
  types.AudioStreamingSamplerate = homebridge.hap.AudioStreamingSamplerate
  types.UUIDGen = homebridge.hap.uuid
  types.HapStatusError = homebridge.hap.HapStatusError
  types.HAPStatus = homebridge.hap.HAPStatus
}
