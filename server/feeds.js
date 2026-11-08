// Connects to Network Rail's open data feeds (STOMP over TCP) and hands
// each message batch to a callback. Reconnects with exponential backoff
// and uses durable subscriptions so a short drop doesn't lose messages.

import stompit from 'stompit';

export const TOPICS = {
  td: process.env.NR_TD_TOPIC || '/topic/TD_ALL_SIG_AREA',
  trust: process.env.NR_TRUST_TOPIC || '/topic/TRAIN_MVT_ALL_TOC'
};

export function connectFeeds({ user, pass, topics = ['td', 'trust'], onMessage, log = console.log }) {
  const host = process.env.NR_HOST || 'publicdatafeeds.networkrail.co.uk';
  const port = Number(process.env.NR_PORT || 61618);
  const clientId = process.env.NR_CLIENT_ID || user;
  const manager = new stompit.ConnectFailover(
    [{ host, port, connectHeaders: { host: '/', login: user, passcode: pass, 'heart-beat': '15000,15000', 'client-id': clientId } }],
    { initialReconnectDelay: 1000, maxReconnectDelay: 60000, useExponentialBackOff: true, maxReconnects: -1, randomize: false }
  );
  manager.on('error', (e) => log('[feeds] connection error:', e.message));
  manager.on('connecting', (c) => log('[feeds] connecting to', c.serverProperties.remoteAddress.transportPath));

  const channel = new stompit.Channel(manager, { alwaysConnected: true });
  for (const name of topics) {
    const destination = TOPICS[name];
    channel.subscribe(
      { destination, ack: 'client-individual', 'activemq.subscriptionName': clientId + '-' + name },
      (err, message, sub) => {
        if (err) return log('[feeds] subscribe error on', destination, err.message);
        message.readString('utf-8', (e, body) => {
          channel.ack(message);
          if (e) return;
          try { onMessage(name, JSON.parse(body)); } catch (x) { log('[feeds] bad message on', name, x.message); }
        });
      }
    );
    log('[feeds] subscribed to', destination);
  }
  return () => channel.close();
}
