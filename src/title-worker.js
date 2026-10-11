// Runs the title-fight simulation off the main thread (see data.js).
const { parentPort, workerData } = require('worker_threads');
const { titleFight } = require('./championship');

parentPort.postMessage(titleFight(workerData));
