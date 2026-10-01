import http from 'node:http';
import handler from './api/index.mjs';
http.createServer(handler).listen(4319, '127.0.0.1', () => console.log('Tokenomics local server: http://127.0.0.1:4319'));
