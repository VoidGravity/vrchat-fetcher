const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class VRChatFetcher {
    constructor() {
        this.baseUrl = 'https://api.vrchat.cloud/api/1';
        this.credentials = {
            username: process.env.VRCHAT_USERNAME || '',
            password: process.env.VRCHAT_PASSWORD || ''
        };
        this.authCookie = '';
        this.userAgent = 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36';
        this.sortTypes = ['popularity', 'heat', 'hotness'];
        this.isRunning = false;
        this.manualTrigger = false;
        
        // Create data directories
        this.ensureDirectories();
        
        // Start HTTP server for manual trigger
        this.startServer();
    }

    ensureDirectories() {
        const dirs = ['data', 'data/scheduled', 'data/manual'];
        dirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    startServer() {
        const server = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            
            if (req.method === 'GET' && req.url === '/status') {
                res.writeHead(200);
                res.end(JSON.stringify({
                    status: 'running',
                    isRunning: this.isRunning,
                    lastRun: this.getLastRunTime()
                }));
            } else if (req.method === 'POST' && req.url === '/trigger') {
                if (!this.isRunning) {
                    this.manualTrigger = true;
                    this.fetchAllData().catch(console.error);
                    res.writeHead(200);
                    res.end(JSON.stringify({ message: 'Manual fetch triggered' }));
                } else {
                    res.writeHead(429);
                    res.end(JSON.stringify({ message: 'Fetch already in progress' }));
                }
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ message: 'Not found' }));
            }
        });

        const port = process.env.PORT || 3000;
        server.listen(port, () => {
            console.log(`Server running on port ${port}`);
            console.log(`Status: GET http://localhost:${port}/status`);
            console.log(`Manual trigger: POST http://localhost:${port}/trigger`);
        });
    }

    async makeRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port || 443,
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                headers: {
                    'User-Agent': this.userAgent,
                    ...options.headers
                }
            };

            const client = urlObj.protocol === 'https:' ? https : http;
            const req = client.request(requestOptions, (res) => {
                let data = '';
                
                res.on('data', chunk => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);
                        resolve({
                            status: res.statusCode,
                            headers: res.headers,
                            data: jsonData
                        });
                    } catch (e) {
                        resolve({
                            status: res.statusCode,
                            headers: res.headers,
                            data: data
                        });
                    }
                });
            });

            req.on('error', reject);
            
            if (options.body) {
                req.write(JSON.stringify(options.body));
            }
            
            req.end();
        });
    }

    async authenticate() {
        console.log('Authenticating with VRChat...');
        
        if (!this.credentials.username || !this.credentials.password) {
            throw new Error('Username and password must be set in environment variables');
        }

        const auth = Buffer.from(
            `${encodeURIComponent(this.credentials.username)}:${encodeURIComponent(this.credentials.password)}`
        ).toString('base64');

        try {
            const response = await this.makeRequest(`${this.baseUrl}/auth/user`, {
                headers: {
                    'Authorization': `Basic ${auth}`
                }
            });

            if (response.status === 200 && response.data.authToken) {
                this.authCookie = `auth=authcookie*${response.data.authToken}`;
                console.log('Authentication successful');
                return true;
            } else if (response.status === 401) {
                console.error('Authentication failed:', response.data);
                throw new Error('Invalid credentials or 2FA required');
            } else {
                console.error('Unexpected response:', response);
                throw new Error(`Authentication failed with status ${response.status}`);
            }
        } catch (error) {
            console.error('Authentication error:', error);
            throw error;
        }
    }

    async fetchWorlds(sort, offset = 0) {
        const url = `${this.baseUrl}/worlds?sort=${sort}&n=100&offset=${offset}`;
        
        const response = await this.makeRequest(url, {
            headers: {
                'Cookie': this.authCookie
            }
        });

        if (response.status === 401) {
            console.log('Token expired, re-authenticating...');
            await this.authenticate();
            
            // Retry with new token
            const retryResponse = await this.makeRequest(url, {
                headers: {
                    'Cookie': this.authCookie
                }
            });
            
            return retryResponse;
        }

        return response;
    }

    async fetchAllData() {
        if (this.isRunning) {
            console.log('Fetch already in progress, skipping...');
            return;
        }

        this.isRunning = true;
        const startTime = new Date();
        const folderName = this.manualTrigger ? 'manual' : 'scheduled';
        const timestamp = startTime.toISOString().replace(/[:.]/g, '-');
        
        console.log(`Starting ${folderName} data fetch at ${startTime.toISOString()}`);

        try {
            // Ensure we have valid authentication
            if (!this.authCookie) {
                await this.authenticate();
            }

            const allResults = {};
            let totalRequests = 0;

            for (const sort of this.sortTypes) {
                console.log(`Fetching data for sort: ${sort}`);
                allResults[sort] = [];

                // Fetch 5 pages (0-400 offset, 100 per page = 500 total)
                for (let page = 0; page < 5; page++) {
                    const offset = page * 100;
                    
                    try {
                        console.log(`  Page ${page + 1}/5 (offset: ${offset})`);
                        const response = await this.fetchWorlds(sort, offset);
                        
                        if (response.status === 200 && Array.isArray(response.data)) {
                            allResults[sort].push(...response.data);
                            totalRequests++;
                            
                            // Rate limiting: wait 2 seconds between requests
                            if (page < 4) { // Don't wait after the last request of a sort
                                await this.sleep(2000);
                            }
                        } else if (response.status === 429) {
                            console.log('Rate limited, waiting 30 seconds...');
                            await this.sleep(30000);
                            page--; // Retry this page
                            continue;
                        } else {
                            console.error(`Failed to fetch ${sort} page ${page + 1}:`, response);
                        }
                    } catch (error) {
                        console.error(`Error fetching ${sort} page ${page + 1}:`, error);
                    }
                }

                console.log(`Collected ${allResults[sort].length} worlds for ${sort}`);
                
                // Wait between different sort types
                if (sort !== this.sortTypes[this.sortTypes.length - 1]) {
                    await this.sleep(3000);
                }
            }

            // Save results
            const filename = `vrchat_worlds_${timestamp}.json`;
            const filepath = path.join('data', folderName, filename);
            
            const result = {
                timestamp: startTime.toISOString(),
                totalRequests,
                type: folderName,
                data: allResults,
                summary: {
                    popularity: allResults.popularity?.length || 0,
                    heat: allResults.heat?.length || 0,
                    hotness: allResults.hotness?.length || 0
                }
            };

            fs.writeFileSync(filepath, JSON.stringify(result, null, 2));
            console.log(`Data saved to ${filepath}`);
            
            // Save summary log
            const logEntry = `${startTime.toISOString()}: ${folderName} fetch completed - ${totalRequests} requests, ${result.summary.popularity + result.summary.heat + result.summary.hotness} total worlds\n`;
            fs.appendFileSync(path.join('data', 'fetch_log.txt'), logEntry);

        } catch (error) {
            console.error('Fetch failed:', error);
        } finally {
            this.isRunning = false;
            this.manualTrigger = false;
            console.log(`Fetch completed in ${Date.now() - startTime.getTime()}ms`);
        }
    }

    getLastRunTime() {
        try {
            const logPath = path.join('data', 'fetch_log.txt');
            if (fs.existsSync(logPath)) {
                const log = fs.readFileSync(logPath, 'utf8');
                const lines = log.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                return lastLine.split(':')[0];
            }
        } catch (error) {
            console.error('Error reading last run time:', error);
        }
        return null;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    start() {
        console.log('VRChat Fetcher started');
        console.log('Environment check:');
        console.log('- Username set:', !!this.credentials.username);
        console.log('- Password set:', !!this.credentials.password);
        
        // Initial authentication
        this.authenticate().catch(console.error);
        
        // Schedule hourly fetches
        const runFetch = () => {
            this.fetchAllData().catch(console.error);
        };

        // Run immediately if not in manual mode
        if (process.env.IMMEDIATE_START !== 'false') {
            setTimeout(runFetch, 5000); // Wait 5 seconds for server to start
        }

        // Schedule every hour
        setInterval(runFetch, 60 * 60 * 1000);
        
        console.log('Scheduled to run every hour');
    }
}

// Start the fetcher
const fetcher = new VRChatFetcher();
fetcher.start();