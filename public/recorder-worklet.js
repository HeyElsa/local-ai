// Copies raw microphone samples to the page, where they are encoded as WAV.
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);
