const fs = require('node:fs')
const { Buffer } = require('node:buffer')

class Mp3Info {
  constructor(frameHeader, frameXingHeader) {
    this.frameHeader = frameHeader
    this.frameXingHeader = frameXingHeader
  }

  xingFlags() {
    return this.frameXingHeader.readUInt32BE(4) // 0x00 0x00 0x00 0x0f this means that the four flags are present in the file
  }

  xingFrames() {
    return this.frameXingHeader.readUInt32BE(8)
  }

  mpegVersionBits() {
    return (this.frameHeader[1] & 0x18) >> 3
  }

  layerBits() {
    return (this.frameHeader[1] & 0x6) >> 1
  }

  protectionBits() {
    return this.frameHeader[1] & 0x1
  }

  bitrateBits() {
    return (this.frameHeader[2] & 0xf0) >> 4
  }

  /**
   * @returns {number | 'free' | 'bad'}
   * Returns bitrate in kbps
   */
  getBitrate() {
    const BITRATE_TABLE = {
      'MPEG 1': [
        [
          0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
          0,
        ], // layer 1
        [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0], // layer 2
        [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0], // layer 3
      ],
      'MPEG 2': [
        // MPEG 2 and MPEG 2.5
        [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0], // layer 1
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0], // layer 2
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0], // layer 3
      ],
    } // all values are in kbps
    const version = (this.mpegVersionBits() & 0x01) === 0 ? 'MPEG 2' : 'MPEG 1'
    const layerIndex = this.layerBits()
    const bitrateIndex = this.bitrateBits()

    if (
      layerIndex < 0 ||
      layerIndex > 2 ||
      bitrateIndex < 0 ||
      bitrateIndex > 15
    ) {
      throw new Error('Invalid layer or bitrate index')
    }

    return BITRATE_TABLE[version][layerIndex][bitrateIndex]
  }

  frequencyBits() {
    return (this.frameHeader[2] & 0xc) >> 2
  }

  paddingBits() {
    return (this.frameHeader[2] & 0x2) >> 1
  }

  samplesPerFrame() {
    const layer = this.getLayer()
    const version = this.getMPEGVersion()
    if (layer === 'Layer I') {
      return 384
    }

    if (layer === 'Layer II') {
      return 1152
    }

    if (layer === 'Layer III') {
      if (version === 'MPEG 1') {
        return 1152
      }

      // for versions 2 and 2.5
      return 576
    }
  }

  getMPEGVersion() {
    const table = ['MPEG 2.5', 'reserved', 'MPEG 2', 'MPEG 1']
    return table[this.mpegVersionBits()]
  }

  getLayer() {
    const table = ['reserved', 'Layer III', 'Layer II', 'Layer I']
    return table[this.layerBits()]
  }

  /**
   * aka Sample Rate
   */
  getFrequency() {
    const table = [
      [44100, 48000, 32000, 'reserved'], // v1
      [22050, 24000, 16000, 'reserved'], // v2
      [11025, 12000, 8000, 'reserved'], // v2.5
    ]

    const freqIdx = this.frequencyBits()
    switch (this.getMPEGVersion()) {
      case 'MPEG 2.5':
        return table[2][freqIdx]
      case 'MPEG 2':
        return table[1][freqIdx]
      case 'MPEG 1':
        return table[0][freqIdx]
      default:
        throw new Error('not a valid frequency')
    }
  }

  getDuration() {
    // VBR
    // Number of frames * Samples Per Frame  / Sampling Rate (aka frequency)
    if (this.frameXingHeader) {
      return (this.xingFrames() * this.samplesPerFrame()) / this.getFrequency()
    }
    // CBR
    // File Size in bits / bitrate in bps
    return (fileSize * 8) / (this.getBitrate() * 1000)
  }

  formatHHMMSS(duration) {
    const hours = Math.floor(duration / 3600)
    const minutes = Math.floor((duration % 3600) / 60)
    const seconds = Math.floor(duration % 60)

    const fHours = String(hours).padStart(2, '0')
    const fMinutes = String(minutes).padStart(2, '0')
    const fSeconds = String(seconds).padStart(2, '0')

    return `${fHours}:${fMinutes}:${fSeconds}`
  }
}

/*
 *
 * @typedef {Object} Info
 * @property {number} duration - in seconds
 * @property {number} bitrate
 * @property {number} frequency
 * @property {string} layer
 * @property {version} version
 */

let fd
let fileSize
/**
 * Loads the MP3 metadata (id3 tags not included)
 *
 * @param {string} path
 * @return {Info}
 *         The metadata of the MP3
 */
function load(path) {
  fd = fs.openSync(path)
  fileSize = fs.statSync(path).size

  let pos = id3Size()
  const frameHeader = mp3FrameHeader(pos)
  if (frameHeader === null) {
    throw new Error('Not a valid MP3 file')
  }
  pos += frameHeader.length
  const frameXingHeader = xingHeader(pos + 10) // 10 is the offset from the headerframe

  const reader = new Mp3Info(frameHeader, frameXingHeader)
  const duration = reader.getDuration()
  const bitrate = reader.getBitrate()
  const layer = reader.getLayer()
  const version = reader.getMPEGVersion()
  const frequency = reader.getFrequency()

  return { duration, bitrate, frequency, layer, version }
}

function xingHeader(pos) {
  const IDENTIFIER_SIZE = 4
  const FLAGS_SIZE = 4
  const FRAMES_SIZE = 4
  const BYTES_SIZE = 4
  const TOC_SIZE = 100
  const VBR_SIZE = 4

  let buffer = Buffer.alloc(40)
  fs.readSync(fd, buffer, 0, buffer.length, pos)
  let size = 0
  let offset = 0

  for (let i = 0; i < buffer.length - IDENTIFIER_SIZE; i++) {
    // If size is greater than 0, it means that "Xing" or "Info" identifier was found
    if (size) break

    let identifier = buffer.toString('ascii', i, i + IDENTIFIER_SIZE)
    if (identifier === 'Info' || identifier === 'Xing') {
      size += IDENTIFIER_SIZE + FLAGS_SIZE
      offset = i
      const flags = buffer.readUInt32BE(i + 4)

      // frame flag
      if (flags & 0x01) {
        size += FRAMES_SIZE
      }

      // bytes flag
      if (flags & 0x02) {
        size += BYTES_SIZE
      }

      // TOC flag
      if (flags & 0x04) {
        size += TOC_SIZE
      }

      // VBR scale flag
      if (flags & 0x08) {
        size += VBR_SIZE
      }
    }
  }

  // Didn't find xing/info tags
  if (!size) return

  return Buffer.copyBytesFrom(buffer, offset, size)
}

/**
 * @param {number} pos
 * @returns {Buffer | null} The MP3 frame header bytes, returns null if not found
 */
function mp3FrameHeader(pos) {
  const buffer = Buffer.alloc(4)
  fs.readSync(fd, buffer, 0, buffer.length, pos)

  if ((buffer[0] === 0xff) & ((buffer[1] & 0xc0) === 0xc0)) {
    return buffer
  }

  return null
}

/**
 * Only supports ID3v2
 * @returns the size in bytes of the ID3 segment
 */
function id3Size() {
  const HEADER_SIZE = 10
  const buffer = Buffer.alloc(HEADER_SIZE)
  fs.readSync(fd, buffer)

  if (buffer.toString('utf8', 0, 3) !== 'ID3') {
    return 0
  }

  const headerSize = 10
  if (buffer.length < headerSize) {
    return 0
  }

  // The size flag doesn't sum to its value the ID3 Header size
  // it only considers the size of the ID3 data
  return (
    (((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f)) +
    HEADER_SIZE
  )
}

module.exports = {
  load,
}
