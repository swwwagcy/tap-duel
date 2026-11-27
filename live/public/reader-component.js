// The card reader as a component another page can use. The reader looks at the table through a
// camera and says what it sees in each position; it knows nothing about the game's rules, the
// round or the server. The page that mounts it decides what to do with each reading.
//
//   var reader = CardReader.mount(element, {
//     game: 'duel',                 // which game's positions to look at (Games.GAMES)
//     demo: false,                  // use the simulated camera
//     autostart: false,             // demo only: start the simulated camera at once
//     onReport: function (message) {}   // { t: 'zone', table, zone, state: 'empty'|'back'|'card'|'unsure', card, score, margin, top, shot }
//                                       // { t: 'frame', table, image }   a small picture of the table, about every 0.7 s
//                                       // { t: 'status', table, text }   frames per second, card size, warnings
//   });
//   reader.setTable(view);          // the table's state (phase, next position): some readings only count in some phases
//   reader.destroy();
//
// The reader runs in its own frame, so it keeps reading while the page shows something else, as
// long as the frame stays rendered (cover it, do not set display: none).
(function (root) {
  'use strict';
  function mount(element, options) {
    options = options || {};
    var frame = document.createElement('iframe');
    frame.title = '讀牌器';
    frame.allow = 'camera';
    frame.src = 'reader.html?component&embed&table=' + encodeURIComponent(options.game || 'duel') + (options.demo ? '&demo' : '') + (options.autostart ? '&autostart' : '');
    var pending = null, ready = false;
    function post(message) { frame.contentWindow.postMessage({ source: 'card-reader-host', message: message }, location.origin); }
    function onMessage(event) {
      if (event.origin !== location.origin || event.source !== frame.contentWindow || !event.data || event.data.source !== 'card-reader') return;
      var message = event.data.message;
      if (!message) return;
      if (message.t === 'ready') { ready = true; if (pending) post(pending); if (options.onReady) options.onReady(); return; }
      if (options.onReport) options.onReport(message);
    }
    window.addEventListener('message', onMessage);
    element.appendChild(frame);
    return {
      frame: frame,
      setTable: function (view) { pending = { t: 'table', table: view }; if (ready) post(pending); },
      destroy: function () { window.removeEventListener('message', onMessage); frame.remove(); }
    };
  }
  root.CardReader = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
