'use strict';
// Loads the server the way Claude Desktop's built-in Node does: through a separate bootstrap
// script, so require.main is this file and process.argv[1] names the server.
const target = process.argv[2];
// node --test also loads this file on its own; then there is nothing to start.
if (target) {
  process.argv = [process.argv[0], target];
  require(target);
}
