const crypto = require("crypto");
const { spawn } = require("child_process");
const { createSocket } = require("dgram");
let ffmpegForHomebridge;
try {
  ffmpegForHomebridge = require("ffmpeg-for-homebridge");
} catch {
  ffmpegForHomebridge = null;
}
const {
  SRTPCryptoSuites,
  H264Profile,
  H264Level,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
} = require("../types");

const DEFAULT_MAX_BITRATE = 299;
const DEFAULT_AUDIO_BITRATE = 24;
const DEFAULT_PACKET_SIZE = 1316;
const SNAPSHOT_TIMEOUT_MS = 15000;
const PENDING_SESSION_TIMEOUT_MS = 30000;
const MAX_LOG_LENGTH = 2000;

module.exports = class WyzeCameraStreamingDelegate {
  constructor(plugin, accessory, streamConfig) {
    this.plugin = plugin;
    this.accessory = accessory;
    this.streamConfig = streamConfig;
    this.pendingSessions = new Map();
    this.ongoingSessions = new Map();
  }

  get source() {
    return this.streamConfig.source;
  }

  get snapshotSource() {
    return this.streamConfig.stillImageSource || this.source;
  }

  get videoProcessor() {
    return (
      this.streamConfig.ffmpegPath ||
      this.streamConfig.videoProcessor ||
      this.plugin.config.ffmpegPath ||
      this.plugin.config.videoProcessor ||
      ffmpegForHomebridge ||
      "ffmpeg"
    );
  }

  get logLevel() {
    if (this.streamConfig.debug || this.plugin.config.debug) {
      return "info";
    }

    if (this.plugin.config.pluginLoggingEnabled) {
      return "warning";
    }

    return "error";
  }

  get includeAudio() {
    return this.streamConfig.audio === true;
  }

  getInputOptions(source) {
    if (!source.toLowerCase().startsWith("rtsp://")) {
      return [];
    }

    return ["-rtsp_transport", this.streamConfig.rtspTransport || "tcp"];
  }

  get streamingOptions() {
    const options = {
      supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: {
        codec: {
          profiles: [
            H264Profile.BASELINE,
            H264Profile.MAIN,
            H264Profile.HIGH,
          ],
          levels: [
            H264Level.LEVEL3_1,
            H264Level.LEVEL3_2,
            H264Level.LEVEL4_0,
          ],
        },
        resolutions: [
          [320, 180, 30],
          [480, 270, 30],
          [640, 360, 30],
          [1280, 720, 30],
          [1920, 1080, 30],
        ],
      },
    };

    if (this.includeAudio) {
      options.audio = {
        codecs: [
          {
            type: AudioStreamingCodecType.AAC_ELD,
            samplerate: AudioStreamingSamplerate.KHZ_16,
          },
        ],
      };
    }

    return options;
  }

  async prepareStream(request, callback) {
    let videoReturn;
    try {
      const ipv6 = request.addressVersion === "ipv6";
      videoReturn = await this.reserveReturnPort(ipv6);
      const sessionInfo = {
        address: request.targetAddress,
        ipv6,
        videoPort: request.video.port,
        videoReturnPort: videoReturn.port,
        videoReturnSocket: videoReturn.socket,
        videoCryptoSuite: request.video.srtpCryptoSuite,
        videoKey: request.video.srtp_key,
        videoSalt: request.video.srtp_salt,
        videoSSRC: this.generateSSRC(),
        pendingTimer: null,
      };

      const response = {
        video: {
          port: sessionInfo.videoReturnPort,
          ssrc: sessionInfo.videoSSRC,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
      };

      if (this.includeAudio && request.audio) {
        const audioReturn = await this.reserveReturnPort(ipv6);
        sessionInfo.audioPort = request.audio.port;
        sessionInfo.audioReturnPort = audioReturn.port;
        sessionInfo.audioReturnSocket = audioReturn.socket;
        sessionInfo.audioCryptoSuite = request.audio.srtpCryptoSuite;
        sessionInfo.audioKey = request.audio.srtp_key;
        sessionInfo.audioSalt = request.audio.srtp_salt;
        sessionInfo.audioSSRC = this.generateSSRC();
        response.audio = {
          port: sessionInfo.audioReturnPort,
          ssrc: sessionInfo.audioSSRC,
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        };
      }

      sessionInfo.pendingTimer = setTimeout(() => {
        if (this.pendingSessions.delete(request.sessionID)) {
          this.closeSessionSockets(sessionInfo);
        }
      }, PENDING_SESSION_TIMEOUT_MS);

      this.pendingSessions.set(request.sessionID, sessionInfo);
      callback(undefined, response);
    } catch (error) {
      if (videoReturn?.socket) {
        this.closeSessionSockets({ videoReturnSocket: videoReturn.socket });
      }
      callback(error);
    }
  }

  handleStreamRequest(request, callback) {
    switch (request.type) {
      case "start":
        this.startStream(request, callback);
        break;
      case "stop":
        this.stopStream(request.sessionID);
        callback();
        break;
      case "reconfigure":
        callback();
        break;
      default:
        callback(new Error(`Unknown stream request type: ${request.type}`));
    }
  }

  handleSnapshotRequest(request, callback) {
    const args = [
      "-hide_banner",
      "-loglevel",
      this.logLevel,
      "-y",
      ...this.getInputOptions(this.snapshotSource),
      "-i",
      this.snapshotSource,
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-vcodec",
      "mjpeg",
      "-",
    ];

    if (request.width && request.height) {
      args.splice(args.length - 1, 0, "-s", `${request.width}x${request.height}`);
    }

    const ffmpeg = this.spawnFfmpeg(args);
    const chunks = [];
    let stderr = "";
    let callbackCalled = false;
    let timeout;

    const finish = (error, snapshot) => {
      if (callbackCalled) {
        return;
      }

      callbackCalled = true;
      clearTimeout(timeout);
      callback(error, snapshot);
    };

    timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
    }, SNAPSHOT_TIMEOUT_MS);

    ffmpeg.stdout.on("data", (data) => chunks.push(data));
    ffmpeg.stderr.on("data", (data) => {
      stderr = this.appendLog(stderr, data);
    });
    ffmpeg.on("error", (error) => {
      finish(error);
    });
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        finish(undefined, Buffer.concat(chunks));
      } else {
        finish(new Error(`Snapshot failed for ${this.accessory.display_name}: ${this.redact(stderr) || code}`));
      }
    });
  }

  startStream(request, callback) {
    const sessionInfo = this.pendingSessions.get(request.sessionID);
    if (!sessionInfo) {
      callback(new Error(`No prepared session found for ${this.accessory.display_name}`));
      return;
    }

    const video = request.video || {};
    const maxBitrate = video.max_bit_rate || DEFAULT_MAX_BITRATE;
    const fps = video.fps || 30;
    const packetSize = video.mtu || DEFAULT_PACKET_SIZE;
    const width = video.width || 1280;
    const height = video.height || 720;
    const address = sessionInfo.ipv6 ? `[${sessionInfo.address}]` : sessionInfo.address;
    const videoParams = Buffer.concat([sessionInfo.videoKey, sessionInfo.videoSalt]).toString("base64");
    const audioParams = sessionInfo.audioKey && sessionInfo.audioSalt
      ? Buffer.concat([sessionInfo.audioKey, sessionInfo.audioSalt]).toString("base64")
      : null;
    const videoPayloadType = video.pt || 99;

    const args = [
      "-hide_banner",
      "-loglevel",
      this.logLevel,
      "-re",
      ...this.getInputOptions(this.source),
      "-i",
      this.source,
      "-an",
      "-sn",
      "-dn",
      "-codec:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "baseline",
      "-level",
      "3.1",
      "-b:v",
      `${maxBitrate}k`,
      "-bufsize",
      `${maxBitrate * 2}k`,
      "-maxrate",
      `${maxBitrate}k`,
      "-r",
      `${fps}`,
      "-s",
      `${width}x${height}`,
      "-payload_type",
      `${videoPayloadType}`,
      "-ssrc",
      `${sessionInfo.videoSSRC}`,
      "-f",
      "rtp",
      "-srtp_out_suite",
      "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params",
      videoParams,
      `srtp://${address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=${packetSize}`,
    ];

    if (this.includeAudio && audioParams && request.audio) {
      const audio = request.audio;
      const audioPayloadType = audio.pt || 110;
      const audioSampleRate = audio.sample_rate || 16;
      const audioBitrate = audio.max_bit_rate || DEFAULT_AUDIO_BITRATE;
      const audioChannels = audio.channel || 1;

      args.push(
        "-vn",
        "-sn",
        "-dn",
        "-codec:a",
        "libfdk_aac",
        "-profile:a",
        "aac_eld",
        "-ar",
        `${audioSampleRate}k`,
        "-b:a",
        `${audioBitrate}k`,
        "-ac",
        `${audioChannels}`,
        "-payload_type",
        `${audioPayloadType}`,
        "-ssrc",
        `${sessionInfo.audioSSRC}`,
        "-f",
        "rtp",
        "-srtp_out_suite",
        "AES_CM_128_HMAC_SHA1_80",
        "-srtp_out_params",
        audioParams,
        `srtp://${address}:${sessionInfo.audioPort}?rtcpport=${sessionInfo.audioPort}&pkt_size=${packetSize}`
      );
    }

    const ffmpeg = this.spawnFfmpeg(args);
    clearTimeout(sessionInfo.pendingTimer);
    this.pendingSessions.delete(request.sessionID);
    this.ongoingSessions.set(request.sessionID, {
      ffmpeg,
      videoReturnSocket: sessionInfo.videoReturnSocket,
      audioReturnSocket: sessionInfo.audioReturnSocket,
    });

    ffmpeg.stderr.on("data", (data) => {
      if (this.plugin.config.pluginLoggingEnabled) {
        this.plugin.log(
          `[Camera] [Stream] ${this.accessory.display_name}: ${this.redact(data)}`
        );
      }
    });

    ffmpeg.on("error", (error) => {
      this.stopStream(request.sessionID);
      this.plugin.log.error(
        `[Camera] [Stream] Error starting ${this.accessory.display_name}: ${error}`
      );
    });

    ffmpeg.on("close", () => {
      const session = this.ongoingSessions.get(request.sessionID);
      if (session) {
        this.closeSessionSockets(session);
      }
      this.pendingSessions.delete(request.sessionID);
      this.ongoingSessions.delete(request.sessionID);
    });

    callback();
  }

  stopStream(sessionID) {
    const pendingSession = this.pendingSessions.get(sessionID);
    const session = this.ongoingSessions.get(sessionID);
    this.pendingSessions.delete(sessionID);
    this.ongoingSessions.delete(sessionID);

    if (pendingSession) {
      clearTimeout(pendingSession.pendingTimer);
      this.closeSessionSockets(pendingSession);
    }

    if (session) {
      this.closeSessionSockets(session);
      session.ffmpeg.kill("SIGTERM");
    }
  }

  reserveReturnPort(ipv6) {
    return new Promise((resolve, reject) => {
      const socket = createSocket(ipv6 ? "udp6" : "udp4");
      const cleanup = () => {
        socket.removeAllListeners("error");
        socket.removeAllListeners("listening");
      };

      socket.once("error", (error) => {
        cleanup();
        try {
          socket.close();
        } catch {
          // Socket may already be closed after an error.
        }
        reject(error);
      });

      socket.once("listening", () => {
        const address = socket.address();
        cleanup();
        resolve({
          socket,
          port: address.port,
        });
      });

      socket.bind(0, ipv6 ? "::" : "0.0.0.0");
    });
  }

  closeSessionSockets(session) {
    for (const socket of [session.videoReturnSocket, session.audioReturnSocket]) {
      if (socket) {
        try {
          socket.close();
        } catch {
          // Ignore sockets that have already been closed.
        }
      }
    }
  }

  spawnFfmpeg(args) {
    return spawn(this.videoProcessor, args, {
      env: process.env,
      shell: false,
      windowsHide: true,
    });
  }

  appendLog(current, data) {
    const next = current + this.redact(data);
    if (next.length <= MAX_LOG_LENGTH) {
      return next;
    }

    return next.slice(next.length - MAX_LOG_LENGTH);
  }

  redact(value) {
    return String(value)
      .split(this.source)
      .join("[REDACTED_URL]")
      .split(this.snapshotSource)
      .join("[REDACTED_URL]")
      .replace(/((?:rtsp|rtsps|http|https):\/\/)[^/@\s]+@/gi, "$1[REDACTED]@");
  }

  generateSSRC() {
    return crypto.randomBytes(4).readUInt32BE(0);
  }
};
