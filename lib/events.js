'use strict';
// Server-Sent Events hub: pushes live updates (approvals, PayPal webhooks) to the UI.
const clients = new Set();

function subscribe(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function publish(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

module.exports = { subscribe, publish };
