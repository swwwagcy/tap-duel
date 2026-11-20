// Demo mode: the game engine running in a shared worker, so every tab of this browser on this site
// (viewer, host, reader) talks to the same tables, exactly as they would talk to the real server.
importScripts('games.js', 'engine.js');
var engine = Engine.createEngine(Engine.DEMO_OPTIONS);
self.onconnect = function (event) {
  var port = event.ports[0];
  var connection = { deliver: function (message) { port.postMessage(message); } };
  engine.connect(connection);
  port.onmessage = function (incoming) {
    if (incoming.data && incoming.data.t === 'bye') { engine.disconnect(connection); return; }
    engine.receive(connection, incoming.data);
  };
  port.start();
};
