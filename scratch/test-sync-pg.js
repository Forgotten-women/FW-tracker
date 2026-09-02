const { Worker, isMainThread, parentPort, workerData, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const path = require('path');
const { Client } = require(path.join(__dirname, '..', 'backend', 'node_modules', 'pg'));

if (isMainThread) {
  const sharedBuffer = new SharedArrayBuffer(4);
  const sharedArray = new Int32Array(sharedBuffer);
  const { port1, port2 } = new MessageChannel();

  const worker = new Worker(__filename, {
    workerData: {
      sharedBuffer,
      port: port2,
      databaseUrl: 'postgresql://postgres.xywqabfcqbrheaqfbyib:h1H1rjrIrPmLDZpq@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'
    },
    transferList: [port2]
  });

  function syncQuery(sql, params = []) {
    Atomics.store(sharedArray, 0, 0);
    port1.postMessage({ sql, params });
    Atomics.wait(sharedArray, 0, 0);
    const msg = receiveMessageOnPort(port1);
    if (msg.message.error) {
      throw new Error(msg.message.error);
    }
    return msg.message.rows;
  }

  // wait 100ms for worker pg connect
  setTimeout(() => {
    try {
      const rows = syncQuery('SELECT count(*) as count FROM employees');
      console.log('SYNC PG RESULT FROM SUPABASE:', rows);
    } catch (err) {
      console.error('SYNC PG ERROR:', err.message);
    } finally {
      worker.terminate();
    }
  }, 1000);
} else {
  const { sharedBuffer, port, databaseUrl } = workerData;
  const sharedArray = new Int32Array(sharedBuffer);
  const client = new Client({ connectionString: databaseUrl });
  
  client.connect().then(() => {
    port.on('message', async ({ sql, params }) => {
      try {
        const res = await client.query(sql, params);
        port.postMessage({ rows: res.rows });
      } catch (err) {
        port.postMessage({ error: err.message });
      }
      Atomics.store(sharedArray, 0, 1);
      Atomics.notify(sharedArray, 0);
    });
  });
}
