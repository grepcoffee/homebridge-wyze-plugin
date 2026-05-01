# Homebridge Wyze Plugin Fork

This repository is a fork of [jfarmer08/homebridge-wyze-smart-home](https://github.com/jfarmer08/homebridge-wyze-smart-home).

This fork keeps the original Wyze Smart Home device support and adds codebase-specific work around camera streaming, safer logging, faster accessory lookup, and Node 24 compatibility.

## What This Plugin Does

This is a Homebridge platform plugin with the platform alias `WyzeSmartHome`. It signs in to a Wyze account through the unofficial Wyze API library, discovers supported Wyze devices, and exposes them to HomeKit as Homebridge accessories.

The plugin polls Wyze for device state, updates HomeKit characteristics, and sends control requests back through the Wyze API when a HomeKit value changes.

Important: this plugin depends on unofficial Wyze API behavior. Wyze can change or block API access without warning.

## Runtime Support

This fork declares support for:

- Homebridge `^1.6.0` or `^2.0.0-beta.0`
- Node.js `^18.20.4`, `^20.15.1`, or `^24.15.0`

The package entrypoint is:

```text
src/index.js
```

The platform name for Homebridge config is:

```text
WyzeSmartHome
```

## Supported Devices

The supported device list comes from `src/enums.js` and the accessory classes in `src/accessories`.

Current supported device groups:

- Wyze plugs and outdoor plugs
- White bulbs
- Mesh/color bulbs
- Light strips
- Contact sensors
- Motion sensors
- Temperature/humidity sensors
- Leak sensors
- Locks
- Lock Bolt v2 / supported common lock models
- Wall switches
- HMS gateway, when enabled
- Thermostat
- Wyze cameras

Camera models currently recognized by this codebase include:

- Wyze Cam v1 HD
- Wyze Cam v2
- Wyze Cam v3
- Wyze Cam v3 Pro
- Wyze Cam v4
- Wyze Cam Pan
- Wyze Cam Pan v2
- Wyze Cam Pan v3
- Wyze Cam Outdoor
- Wyze Cam Outdoor v2

## Camera Support

Cameras still expose the existing privacy/on-off switch behavior from the upstream plugin. This switch controls the Wyze camera privacy/power state through the Wyze API.

This fork also supports HomeKit camera video when you provide a stream source. Wyze does not provide a stable public live-video endpoint through the account API, so this plugin does not magically pull cloud camera video directly from Wyze. Instead, it accepts a local or network video source and presents it to HomeKit through ffmpeg.

Supported stream input types depend on your ffmpeg build, but typical inputs are:

- RTSP from Wyze RTSP firmware, where available
- RTSP or HTTP from `docker-wyze-bridge`
- Another local bridge that exposes the camera as RTSP, HTTP, HLS, or a format ffmpeg can read

Camera streaming is configured per camera MAC address with `cameraStreams`.

## Camera Attachments

For cameras with supported attached accessories, this codebase can expose extra HomeKit services when you list the camera MAC address in the matching config field:

- `garageDoorAccessory`
- `spotLightAccessory`
- `floodLightAccessory`
- `sirenAccessory`
- `notificationAccessory`

These are opt-in because the Wyze API does not describe every physical attachment in a clean HomeKit-ready way.

## Configuration

Use Homebridge Config UI X, or add this platform block manually to your Homebridge config.

```json
{
  "platforms": [
    {
      "platform": "WyzeSmartHome",
      "name": "Wyze",
      "username": "YOUR_WYZE_EMAIL",
      "password": "YOUR_WYZE_PASSWORD",
      "keyId": "YOUR_WYZE_KEY_ID",
      "apiKey": "YOUR_WYZE_API_KEY",
      "refreshInterval": 60000,
      "lowBatteryPercentage": 30,
      "showAdvancedOptions": true,
      "pluginLoggingEnabled": false,
      "apiLogEnabled": false,
      "garageDoorAccessory": ["CAMERA_MAC_ADDRESS"],
      "spotLightAccessory": ["CAMERA_MAC_ADDRESS"],
      "floodLightAccessory": ["CAMERA_MAC_ADDRESS"],
      "sirenAccessory": ["CAMERA_MAC_ADDRESS"],
      "notificationAccessory": ["CAMERA_MAC_ADDRESS"],
      "videoProcessor": "ffmpeg",
      "cameraStreams": [
        {
          "mac": "CAMERA_MAC_ADDRESS",
          "source": "rtsp://user:password@camera-host/live",
          "stillImageSource": "rtsp://user:password@camera-host/live",
          "rtspTransport": "tcp",
          "audio": false,
          "streamCount": 2
        }
      ]
    }
  ]
}
```

## Required Fields

- `platform`: Must be `WyzeSmartHome`.
- `name`: The display name used in Homebridge logs.
- `username`: Your Wyze account email address.
- `password`: Your Wyze account password.
- `keyId`: Wyze developer API key ID.
- `apiKey`: Wyze developer API key.

Wyze API keys are created in the Wyze developer console:

```text
https://developer-api-console.wyze.com
```

Use the same Wyze account that owns the devices you want Homebridge to discover.

## Optional Core Fields

- `refreshInterval`: Polling interval in milliseconds. The schema default is `60000`. The runtime enforces a minimum of `30000`.
- `hms`: Enables HMS gateway support. Defaults to `false`.
- `showAdvancedOptions`: Shows advanced configuration fields in Homebridge Config UI X.
- `apiLogEnabled`: Enables Wyze API logging. Leave this off unless debugging.
- `pluginLoggingEnabled`: Enables plugin debug logging. This fork redacts known secrets before logging, but you should still avoid enabling verbose logs longer than needed.
- `lowBatteryPercentage`: Battery threshold used by battery-powered sensors. Defaults to `30`.

## Device Filtering

This plugin discovers supported devices automatically. You can exclude devices by MAC address or product type.

- `excludeMacAddress`: Enables MAC-based filtering in the config UI.
- `filterByMacAddressList`: List of MAC addresses to ignore.
- `excludedeviceType`: Enables type-based filtering in the config UI.
- `filterDeviceTypeList`: List of device product types to ignore.

Common product type values include:

- `OutdoorPlug`
- `Plug`
- `Light`
- `MeshLight`
- `LightStrip`
- `ContactSensor`
- `MotionSensor`
- `Lock`
- `TemperatureHumidity`
- `LeakSensor`
- `Camera`
- `Common`
- `S1Gateway`
- `Thermostat`

## Camera Stream Fields

`cameraStreams` is an array. Each entry maps one Wyze camera MAC address to one ffmpeg-readable source.

- `mac`: The Wyze camera MAC address.
- `source`: Required stream URL. This can be RTSP, HTTP, or another URL supported by your ffmpeg build.
- `stillImageSource`: Optional snapshot source. Defaults to `source`.
- `rtspTransport`: RTSP transport mode. Use `tcp` for the most reliable HomeKit behavior. Use `udp` only if your network/source needs it.
- `audio`: Enables HomeKit audio. Defaults to `false`. Many ffmpeg builds do not include the AAC ELD encoder HomeKit expects, so video-only is the safer default.
- `streamCount`: Number of concurrent HomeKit camera streams. Defaults to `2`.
- `videoProcessor`: Optional per-camera ffmpeg path. If omitted, the top-level `videoProcessor` value is used.

Top-level `videoProcessor` defaults to:

```text
ffmpeg
```

Set it to a full path if Homebridge cannot find ffmpeg in its PATH.

## Security Notes

This fork includes a safer logging path in `src/WyzeSmartHome.js`.

The logger redacts:

- Wyze password
- Wyze API key and key ID
- MFA code
- common token/secret fields
- camera stream URLs
- usernames/passwords embedded in RTSP, HTTP, or HTTPS URLs

The Homebridge config schema also marks credentials and camera stream URLs as password-style fields so Config UI X treats them more carefully.

Even with redaction, treat Homebridge logs as sensitive when camera streaming or API debugging is enabled.

## Performance Notes

This fork adds a few targeted efficiency changes:

- Accessory lookup is indexed by MAC address.
- Device filters are stored as `Set`s.
- Camera stream configs are indexed by MAC address.
- Supported model checks use cached `Set`s instead of rebuilding arrays during each refresh.
- Removed the infinite refresh loop in favor of a shutdown-aware loop.

These changes are meant to keep polling responsive without changing the public behavior of the plugin.

## Development

Install dependencies before running lint or local Homebridge tests:

```sh
npm install
```

Run lint:

```sh
npm run lint
```

Basic syntax checks can be run with Node:

```sh
node --check src/WyzeSmartHome.js
node --check src/accessories/WyzeCamera.js
node --check src/accessories/WyzeCameraStreamingDelegate.js
```

## Known Limitations

- Live camera video requires a stream source. The Wyze account API alone is not enough.
- Audio is disabled by default because HomeKit audio support depends heavily on the local ffmpeg build.
- The Wyze API is unofficial and may change.
- Some camera attachments must be enabled manually by MAC address.
- The package metadata still follows the upstream package name, `homebridge-wyze-smart-home`, unless you choose to rename and publish this fork separately.

## Credits

This fork is based on [jfarmer08/homebridge-wyze-smart-home](https://github.com/jfarmer08/homebridge-wyze-smart-home).

The upstream project traces back to the original Wyze Homebridge work by [misenhower/homebridge-wyze-connected-home](https://github.com/misenhower/homebridge-wyze-connected-home), with additional inspiration from Wyze community integrations and API clients.
