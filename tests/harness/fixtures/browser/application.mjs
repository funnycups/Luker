import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const { dataRoot, announce = true, readyPrefix } = JSON.parse(process.argv[2]);
const state = path.join(dataRoot, 'state.bin');
const document = '<!doctype html><button id="write">Save</button><output id="result"></output><script>document.querySelector("button").onclick=async()=>{const response=await fetch("/state",{method:"POST"});document.querySelector("output").textContent=await response.text();};</script>';
const server = http.createServer((request, response) => {
    if (request.url === '/release-startup') {
        console.log('browser-resource-ready');
        response.end('ready');
        return;
    }
    if (request.url === '/state' && request.method === 'POST') {
        fs.appendFileSync(state, Buffer.from([0, 255, 13, 10]));
        response.end(String(fs.statSync(state).size));
    } else {
        response.setHeader('content-type', 'text/html');
        response.end(document);
    }
});
server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(path.join(dataRoot, 'bound.json.tmp'), JSON.stringify({ port: server.address().port, pid: process.pid, runtime: { version: process.version, execPath: process.execPath } }));
    fs.renameSync(path.join(dataRoot, 'bound.json.tmp'), path.join(dataRoot, 'bound.json'));
    if (announce) console.log(readyPrefix === undefined ? 'browser-resource-ready' : readyPrefix + server.address().port);
});
process.once('SIGTERM', () => { server.closeAllConnections(); server.close(); });
