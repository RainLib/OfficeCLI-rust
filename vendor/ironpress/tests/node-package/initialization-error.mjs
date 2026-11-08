import init from 'ironpress/node';

try {
  await init();
  throw new Error('initialization unexpectedly succeeded without the packaged WASM binary');
} catch (error) {
  if (!error.message.includes('Failed to initialize Ironpress WebAssembly in Node.js')) {
    throw error;
  }
  if (!error.cause) {
    throw new Error('the Node initialization error did not preserve its cause');
  }
}
