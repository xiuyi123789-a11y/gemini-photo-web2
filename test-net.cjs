
const net = require('net');

function checkConnection(host, port) {
    return new Promise((resolve) => {
        console.log(`Testing connection to ${host}:${port}...`);
        const socket = new net.Socket();
        socket.setTimeout(2000);
        
        socket.on('connect', () => {
            console.log(`✅ Successfully connected to ${host}:${port}`);
            socket.destroy();
            resolve(true);
        });
        
        socket.on('timeout', () => {
            console.log(`❌ Timeout connecting to ${host}:${port}`);
            socket.destroy();
            resolve(false);
        });
        
        socket.on('error', (err) => {
            console.log(`❌ Error connecting to ${host}:${port}: ${err.message}`);
            resolve(false);
        });
        
        socket.connect(port, host);
    });
}

async function runTests() {
    console.log("--- Network Diagnostic ---");
    await checkConnection('127.0.0.1', 3001);
    await checkConnection('localhost', 3001);
    await checkConnection('::1', 3001);
    console.log("--------------------------");
}

runTests();
