const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const nodemailer = require('nodemailer');
const archiver = require('archiver');

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
        this.waitingFor2FA = false;
        this.pendingFetch = null; // Store pending fetch operation to resume after 2FA
        
        // Email configuration
        this.emailConfig = {
            to: 'abdellahbardichwork@gmail.com',
            from: 'abdellahbardichwork@gmail.com',
            appPassword: 'umee modv suvi wdrm'
        };
        this.transporter = null;
        this.lastEmailSent = null;
        this.unsentDataQueue = [];
        this.isFirstFetch = true; // Track if this is the first ever fetch
        this.firstFetchTime = null; // Track when first fetch happened
        
        // Authentication retry state
        this.authRetryState = {
            retryCount: 0,
            lastAttempt: null,
            nextAllowedAttempt: null,
            maxRetries: 5
        };
        
        // Create data directories
        this.ensureDirectories();
        
        // Initialize email transporter
        this.initializeEmail();
        
        // Load authentication retry state
        this.loadAuthRetryState();
        
        // Load first fetch state
        this.loadFirstFetchState();
        
        // Start HTTP server for manual trigger
        this.startServer();
    }

    ensureDirectories() {
        const dirs = ['data', 'data/scheduled', 'data/manual', 'daily-data', 'email-queue', 'auth-retry'];
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
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            
            // Handle preflight requests
            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }
            
            if (req.method === 'GET' && req.url === '/status') {
                res.writeHead(200);
                res.end(JSON.stringify({
                    status: 'running',
                    isRunning: this.isRunning,
                    waitingFor2FA: this.waitingFor2FA || false,
                    hasAuthCookie: !!this.authCookie,
                    lastRun: this.getLastRunTime(),
                    email: {
                        configured: !!this.transporter,
                        lastEmailSent: this.lastEmailSent ? this.lastEmailSent.toISOString() : null,
                        unsentCount: this.unsentDataQueue.length,
                        unsentDates: this.unsentDataQueue
                    }
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
            } else if (req.method === 'POST' && req.url === '/retry') {
                if (this.waitingFor2FA && this.authCookie) {
                    // Re-send the 2FA email by making a new authentication request
                    console.log('Retrying 2FA email request...');
                    res.writeHead(200);
                    res.end(JSON.stringify({ 
                        message: 'New 2FA code requested - check your email',
                        waitingFor2FA: true 
                    }));
                } else {
                    res.writeHead(400);
                    res.end(JSON.stringify({ 
                        message: 'No 2FA request pending or no auth cookie available' 
                    }));
                }
            } else if (req.method === 'POST' && req.url === '/2fa') {
                let body = '';
                req.on('data', chunk => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        if (data.code && typeof data.code === 'string') {
                            this.submit2FACode(data.code).then(success => {
                                res.writeHead(200);
                                res.end(JSON.stringify({ 
                                    success, 
                                    message: success ? '2FA code verified successfully' : '2FA code verification failed'
                                }));
                            }).catch(error => {
                                res.writeHead(400);
                                res.end(JSON.stringify({ 
                                    success: false, 
                                    message: error.message 
                                }));
                            });
                        } else {
                            res.writeHead(400);
                            res.end(JSON.stringify({ message: 'Invalid request. Send {"code":"123456"}' }));
                        }
                    } catch (error) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ message: 'Invalid JSON' }));
                    }
                });
            } else if (req.method === 'POST' && req.url === '/send-email') {
                // Manual email sending endpoint
                let body = '';
                req.on('data', chunk => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body || '{}');
                        const dateStr = data.date || new Date().toISOString().split('T')[0];
                        const date = new Date(dateStr);
                        
                        this.sendDailyDataEmail(date).then(() => {
                            res.writeHead(200);
                            res.end(JSON.stringify({ 
                                success: true,
                                message: `Email sent successfully for ${dateStr}`
                            }));
                        }).catch(error => {
                            res.writeHead(500);
                            res.end(JSON.stringify({ 
                                success: false,
                                message: error.message 
                            }));
                        });
                    } catch (error) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ message: 'Invalid JSON. Send {"date":"2025-08-13"} or empty body for today' }));
                    }
                });
            } else if (req.method === 'POST' && req.url === '/retry-emails') {
                // Retry all unsent emails
                this.retryUnsentEmails().then(() => {
                    res.writeHead(200);
                    res.end(JSON.stringify({ 
                        success: true,
                        message: `Retried ${this.unsentDataQueue.length} unsent emails`,
                        queue: this.unsentDataQueue
                    }));
                }).catch(error => {
                    res.writeHead(500);
                    res.end(JSON.stringify({ 
                        success: false,
                        message: error.message 
                    }));
                });
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ message: 'Not found' }));
            }
        });

        const port = process.env.PORT || 3000;
        server.listen(port, () => {
            console.log(`Server running on port ${port}`);

            console.log(`Status: curl http://localhost:3000/status`);
            console.log(`Manual trigger: POST https://your-app.onrender.com/trigger`);
            console.log(`Submit 2FA: curl -X POST http://localhost:3000/2fa -H "Content-Type: application/json" -d '{"code":"123456"}'`);
            console.log(`Retry 2FA: curl -X POST http://localhost:3000/retry -H "Content-Type: application/json"`);
            console.log(`Send email: curl -X POST http://localhost:3000/send-email -H "Content-Type: application/json" -d '{"date":"2025-08-13"}'`);
            console.log(`Retry emails: curl -X POST http://localhost:3000/retry-emails`);
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

    async authenticate(retryCount = 0, maxRetries = 5) {
        // Check persistent retry state first
        if (!this.canAttemptAuth()) {
            throw new Error('Authentication blocked due to persistent retry limits');
        }
        
        const attempt = this.authRetryState.retryCount + 1;
        console.log(`Authenticating with VRChat... (attempt ${attempt}/${this.authRetryState.maxRetries})`);
        
        // If already waiting for 2FA, don't start a new authentication
        if (this.waitingFor2FA) {
            console.log('Already waiting for 2FA input - skipping authentication');
            return true;
        }
        
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

            if (response.status === 200) {
                // Check if we got a direct auth token
                if (response.data.authToken) {
                    this.authCookie = `auth=authcookie*${response.data.authToken}`;
                    console.log('Authentication successful');
                    this.resetAuthRetryState(); // Reset retry state on success
                    return true;
                }
                
                // Check if 2FA is required
                if (response.data.requiresTwoFactorAuth && response.data.requiresTwoFactorAuth.includes('emailOtp')) {
                    console.log('2FA Email OTP required - extracting auth cookie from response headers');
                    
                    // Extract auth cookie from Set-Cookie header
                    if (response.headers['set-cookie']) {
                        const setCookieHeaders = Array.isArray(response.headers['set-cookie']) 
                            ? response.headers['set-cookie'] 
                            : [response.headers['set-cookie']];
                        
                        for (const cookie of setCookieHeaders) {
                            if (cookie.startsWith('auth=')) {
                                const authValue = cookie.split(';')[0].split('=')[1];
                                this.authCookie = `auth=${authValue}`;
                                this.waitingFor2FA = true;
                                
                                console.log('='.repeat(80));
                                console.log('🔐 TWO-FACTOR AUTHENTICATION REQUIRED');
                                console.log('='.repeat(80));
                                console.log('📧 Check your email for a VRChat verification code');
                                console.log('');
                                console.log(`💻 user : curl -X POST http://localhost:3000/2fa -H "Content-Type: application/json" -d '{"code":"123456"}'`);
                                console.log('');
                                console.log('🌐 Or : curl http://localhost:3000/status to check status');
                                console.log(`For a Manual world fetch trigger: POST http://localhost:3000/trigger`);
                                console.log('⏱️  The service will continue once you submit the code');
                                console.log(`to recieve another 2FA: curl -X POST http://localhost:3000/retry -H "Content-Type: application/json"`);
                                console.log('='.repeat(80));

                                
                                // Don't wait - return success and let the user submit the code
                                // Note: We don't reset retry state here as 2FA still needs to be completed
                                return true;
                            }
                        }
                    }
                    
                    if (!this.authCookie) {
                        this.updateAuthRetryState(true); // Mark as failed
                        throw new Error('Could not extract auth cookie from 2FA response');
                    }
                }
            } else if (response.status === 401) {
                console.error('Authentication failed - Invalid credentials or 2FA required:', response.data);
                this.updateAuthRetryState(true); // Mark as failed
                throw new Error('Invalid credentials or 2FA required');
            } else if (response.status === 429) {
                console.error('Rate limited during authentication:', response.data);
                this.updateAuthRetryState(true); // Mark as failed
                throw new Error('Rate limit exceeded during authentication');
            } else {
                console.error('Unexpected authentication response:', response);
                this.updateAuthRetryState(true); // Mark as failed
                throw new Error(`Authentication failed with status ${response.status}`);
            }
        } catch (error) {
            if (error.message.includes('Authentication blocked due to persistent retry limits')) {
                throw error; // Don't update retry state again
            }
            
            console.error('Authentication network error:', error.message);
            this.updateAuthRetryState(true); // Mark as failed
            throw new Error(`Authentication network error: ${error.message}`);
        }
        
        // If we get here without returning true, authentication failed
        this.updateAuthRetryState(true); // Mark as failed
        throw new Error('Authentication failed - unknown reason');
    }

    async submit2FACode(code) {
        if (!this.authCookie) {
            throw new Error('No auth cookie available. Please authenticate first.');
        }

        console.log(`Submitting 2FA code: ${code}`);

        try {
            const response = await this.makeRequest(`${this.baseUrl}/auth/twofactorauth/emailotp/verify`, {
                method: 'POST',
                headers: {
                    'Cookie': this.authCookie,
                    'Content-Type': 'application/json'
                },
                body: { code: code }
            });

            if (response.status === 200 && response.data.verified) {
                console.log('✅ 2FA verification successful!');
                this.waitingFor2FA = false;
                
                // Verify our auth works now
                const verifyResponse = await this.makeRequest(`${this.baseUrl}/auth`, {
                    headers: {
                        'Cookie': this.authCookie
                    }
                });
                
                if (verifyResponse.status === 200 && verifyResponse.data.ok) {
                    console.log('✅ Authentication fully verified and ready!');
                    this.resetAuthRetryState(); // Reset retry state on successful 2FA completion
                    
                    // If there's a pending fetch operation, resume it
                    if (this.pendingFetch) {
                        console.log('🔄 Resuming pending fetch operation...');
                        const pendingOperation = this.pendingFetch;
                        this.pendingFetch = null;
                        
                        // Resume the fetch operation asynchronously
                        setImmediate(() => {
                            pendingOperation().catch(console.error);
                        });
                    }
                    
                    return true;
                } else {
                    console.log('❌ Auth verification failed after 2FA');
                    return false;
                }
            } else {
                console.error('2FA verification failed:', response);
                return false;
            }
        } catch (error) {
            console.error('2FA submission error:', error.message);
            throw error;
        }
    }

    async fetchWorlds(sort, offset) {
        const url = `${this.baseUrl}/worlds?sort=${sort}&n=100&offset=${offset}`;
        
        const response = await this.makeRequest(url, {
            headers: {
                'Cookie': this.authCookie
            }
        });

        if (response.status === 401) {
            // Check if we're already waiting for 2FA before re-authenticating
            if (this.waitingFor2FA) {
                console.log('Authentication needed but 2FA is pending - deferring fetch');
                throw new Error('2FA_PENDING'); // Special error to handle in calling code
            }
            
            console.log('Token expired, re-authenticating...');
            await this.authenticate();
            
            // If authenticate() resulted in 2FA being required, don't retry immediately
            if (this.waitingFor2FA) {
                console.log('2FA required after re-authentication - deferring fetch');
                throw new Error('2FA_PENDING');
            }
            
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

    async fetchUser(userId) {
        const url = `${this.baseUrl}/users/${userId}`;
        
        const response = await this.makeRequest(url, {
            headers: {
                'Cookie': this.authCookie
            }
        });

        if (response.status === 401) {
            // Check if we're already waiting for 2FA before re-authenticating
            if (this.waitingFor2FA) {
                console.log('Authentication needed but 2FA is pending - deferring user fetch');
                throw new Error('2FA_PENDING');
            }
            
            console.log('Token expired during user fetch, re-authenticating...');
            await this.authenticate();
            
            // If authenticate() resulted in 2FA being required, don't retry immediately
            if (this.waitingFor2FA) {
                console.log('2FA required after re-authentication - deferring user fetch');
                throw new Error('2FA_PENDING');
            }
            
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

    filterWorldData(world) {
        // Remove unwanted fields and add fetch timestamp
        const { udonProducts, unityPackages, ...filteredWorld } = world;
        return {
            ...filteredWorld,
            fetchTimestamp: new Date().toISOString()
        };
    }

    /**
     * Check if a world is a fake/sample world that should be filtered out
     */
    isFakeOrSampleWorld(world) {
        if (!world || !world.name) return false;
        
        const name = world.name.toLowerCase();
        const fakeWorldPatterns = [
            'sample world',
            'test world',
            'fake world',
            'demo world',
            'placeholder world'
        ];
        
        return fakeWorldPatterns.some(pattern => name.includes(pattern));
    }

    /**
     * Filter out fake/sample worlds from an array of worlds
     */
    filterFakeWorlds(worlds) {
        if (!Array.isArray(worlds)) return worlds;
        
        const filtered = worlds.filter(world => !this.isFakeOrSampleWorld(world));
        const removedCount = worlds.length - filtered.length;
        
        if (removedCount > 0) {
            console.log(`🧹 Filtered out ${removedCount} fake/sample worlds`);
        }
        
        return filtered;
    }

    getDailyFileName(date = new Date()) {
        const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD format
        return `${dateStr}.json`;
    }

    loadDailyData(date = new Date()) {
        const filename = this.getDailyFileName(date);
        const filepath = path.join('daily-data', filename);
        
        if (fs.existsSync(filepath)) {
            try {
                const data = fs.readFileSync(filepath, 'utf8');
                return JSON.parse(data);
            } catch (error) {
                console.warn(`Error reading daily file ${filepath}:`, error.message);
                return this.createEmptyDailyData(date);
            }
        }
        
        return this.createEmptyDailyData(date);
    }

    createEmptyDailyData(date = new Date()) {
        return {
            date: date.toISOString().split('T')[0],
            worlds: [],
            users: {}
        };
    }

    /**
     * Process daily data to nest user details inside each world object
     * This creates an enhanced analytics format for email attachments
     */
    createAnalyticsWithNestedUsers(dailyData) {
        if (!dailyData.worlds || !dailyData.users) {
            return dailyData;
        }

        const analyticsData = {
            ...dailyData,
            worlds: dailyData.worlds.map(world => {
                const worldWithUser = { ...world };
                
                // Add user details if available
                if (world.authorId && dailyData.users[world.authorId]) {
                    worldWithUser.author = {
                        ...dailyData.users[world.authorId]
                    };
                }
                
                return worldWithUser;
            })
        };

        // Remove the separate users object since it's now nested
        delete analyticsData.users;
        
        return analyticsData;
    }

    /**
     * Purge all files in the data folder to prevent corruption and legacy data
     */
    purgeDataFolder() {
        const dataFolders = ['data/scheduled', 'data/manual', 'data'];
        let totalPurged = 0;

        dataFolders.forEach(folderPath => {
            if (fs.existsSync(folderPath)) {
                try {
                    const files = fs.readdirSync(folderPath);
                    files.forEach(file => {
                        const filePath = path.join(folderPath, file);
                        const stat = fs.statSync(filePath);
                        
                        if (stat.isFile() && file !== 'fetch_log.txt') { // Keep the log file
                            fs.unlinkSync(filePath);
                            totalPurged++;
                        }
                    });
                } catch (error) {
                    console.warn(`Error purging ${folderPath}:`, error.message);
                }
            }
        });

        if (totalPurged > 0) {
            console.log(`🧹 Purged ${totalPurged} files from data folders`);
        }
    }

    saveDailyData(dailyData, date = new Date()) {
        const filename = this.getDailyFileName(date);
        const filepath = path.join('daily-data', filename);
        
        // Add last updated timestamp
        dailyData.lastUpdated = new Date().toISOString();
        
        fs.writeFileSync(filepath, JSON.stringify(dailyData, null, 2));
        console.log(`Daily data saved to ${filepath}`);
        return filepath;
    }

    extractUniqueUserIds(worldsData) {
        const userIds = new Set();
        
        // Extract author IDs from all worlds across all sort types
        Object.values(worldsData).forEach(worldArray => {
            if (Array.isArray(worldArray)) {
                worldArray.forEach(world => {
                    if (world.authorId) {
                        userIds.add(world.authorId);
                    }
                });
            }
        });
        
        return Array.from(userIds);
    }

    async fetchUsersBatch(userIds, existingUsers = {}) {
        console.log(`Fetching user data for ${userIds.length} unique users...`);
        const users = { ...existingUsers };
        let fetchedCount = 0;
        let errorCount = 0;

        for (const userId of userIds) {
            // Skip if we already have this user's data for today
            if (users[userId] && users[userId].fetchTimestamp) {
                const fetchDate = new Date(users[userId].fetchTimestamp).toDateString();
                const todayDate = new Date().toDateString();
                if (fetchDate === todayDate) {
                    console.log(`  Skipping user ${userId} - already fetched today`);
                    continue;
                }
            }

            try {
                console.log(`  Fetching user ${userId}... (${fetchedCount + 1}/${userIds.length - Object.keys(existingUsers).length})`);
                const response = await this.fetchUser(userId);
                
                if (response.status === 200 && response.data) {
                    users[userId] = {
                        ...response.data,
                        fetchTimestamp: new Date().toISOString()
                    };
                    fetchedCount++;
                } else if (response.status === 404) {
                    console.log(`    User ${userId} not found (404) - skipping`);
                    users[userId] = {
                        id: userId,
                        error: 'User not found',
                        fetchTimestamp: new Date().toISOString()
                    };
                } else if (response.status === 429) {
                    console.log('Rate limited during user fetch, waiting 30 seconds...');
                    await this.sleep(30000);
                    // Retry this user
                    continue;
                } else {
                    console.log(`    Failed to fetch user ${userId}: ${response.status}`);
                    errorCount++;
                }
                
                // Rate limiting: wait 1 second between user requests
                await this.sleep(1000);
                
            } catch (error) {
                if (error.message === '2FA_PENDING') {
                    console.log('2FA authentication required during user fetch - will retry later');
                    throw error;
                }
                
                console.log(`    Error fetching user ${userId}: ${error.message}`);
                errorCount++;
                
                // Continue with next user on individual errors
                continue;
            }
        }

        console.log(`User fetch complete: ${fetchedCount} fetched, ${errorCount} errors`);
        return users;
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
            // Ensure we have valid authentication with retry logic
            if (!this.authCookie) {
                console.log('No auth cookie found, attempting to authenticate...');
                try {
                    await this.authenticate();
                    
                    // If 2FA is required, store this operation for later
                    if (this.waitingFor2FA) {
                        console.log('2FA required - storing fetch operation for later resume');
                        this.pendingFetch = () => this.fetchAllData();
                        this.isRunning = false; // Allow the operation to be resumed later
                        return;
                    }
                } catch (authError) {
                    console.error('Failed to authenticate after all retries:', authError.message);
                    console.log('Scheduling retry in 10 minutes...');
                    setTimeout(() => {
                        if (!this.manualTrigger) { // Only reschedule if it was an automatic run
                            console.log('Retrying fetch after authentication failure...');
                            this.fetchAllData().catch(console.error);
                        }
                    }, 600000); // 10 minutes
                    return;
                }
            }

            const allResults = {};
            let totalRequests = 0;
            let hasErrors = false;

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
                            console.log('Rate limited during fetch, waiting 30 seconds...');
                            await this.sleep(30000);
                            page--; // Retry this page
                            continue;
                        } else {
                            console.error(`Failed to fetch ${sort} page ${page + 1}:`, response);
                            hasErrors = true;
                        }
                    } catch (error) {
                        if (error.message === '2FA_PENDING') {
                            console.log('2FA authentication required - storing fetch operation for later resume');
                            this.pendingFetch = () => this.fetchAllData();
                            this.isRunning = false; // Allow the operation to be resumed later
                            return;
                        }
                        
                        console.error(`Error fetching ${sort} page ${page + 1}:`, error.message);
                        hasErrors = true;
                        
                        // If it's an authentication error, try to re-auth
                        if (error.message.includes('401') || error.message.includes('Unauthorized')) {
                            console.log('Authentication may have expired, clearing cookie...');
                            this.authCookie = '';
                        }
                    }
                }

                console.log(`Collected ${allResults[sort].length} worlds for ${sort}`);
                
                // Wait between different sort types
                if (sort !== this.sortTypes[this.sortTypes.length - 1]) {
                    await this.sleep(3000);
                }
            }

            // Process and filter world data, adding timestamps
            console.log('Processing world data...');
            const processedWorldsData = {};
            Object.keys(allResults).forEach(sort => {
                // First filter world data, then filter out fake/sample worlds
                const filteredWorlds = allResults[sort].map(world => this.filterWorldData(world));
                processedWorldsData[sort] = this.filterFakeWorlds(filteredWorlds);
            });

            // Extract unique user IDs for fetching user data
            const uniqueUserIds = this.extractUniqueUserIds(processedWorldsData);
            console.log(`Found ${uniqueUserIds.length} unique user IDs to fetch`);

            // Load existing daily data to merge
            const dailyData = this.loadDailyData(startTime);
            
            // Add processed worlds to daily data
            dailyData.worlds.push(...Object.values(processedWorldsData).flat());
            
            // Fetch user data for unique user IDs (only if we have auth and no errors so far)
            if (!hasErrors && uniqueUserIds.length > 0) {
                try {
                    console.log('Fetching user data...');
                    const usersData = await this.fetchUsersBatch(uniqueUserIds, dailyData.users);
                    dailyData.users = usersData;
                } catch (userError) {
                    if (userError.message === '2FA_PENDING') {
                        console.log('2FA authentication required during user fetch - storing fetch operation for later resume');
                        this.pendingFetch = () => this.fetchAllData();
                        this.isRunning = false; // Allow the operation to be resumed later
                        return;
                    }
                    
                    console.error('Error fetching user data:', userError.message);
                    hasErrors = true;
                }
            } else {
                console.log('Skipping user data fetch due to world fetch errors or no user IDs');
            }

            // Save daily data file
            const dailyFilePath = this.saveDailyData(dailyData, startTime);

            // Keep backward compatibility: also save in original format
            const filename = `vrchat_worlds_${timestamp}.json`;
            const filepath = path.join('data', folderName, filename);
            
            const result = {
                timestamp: startTime.toISOString(),
                totalRequests,
                type: folderName,
                hasErrors,
                data: allResults, // Keep original format for compatibility
                summary: {
                    popularity: allResults.popularity?.length || 0,
                    heat: allResults.heat?.length || 0,
                    hotness: allResults.hotness?.length || 0
                }
            };

            fs.writeFileSync(filepath, JSON.stringify(result, null, 2));
            console.log(`Legacy data saved to ${filepath}`);
            
            // Save summary log
            const errorFlag = hasErrors ? ' (with errors)' : '';
            const totalUsers = Object.keys(dailyData.users).length;
            const logEntry = `${startTime.toISOString()}: ${folderName} fetch completed${errorFlag} - ${totalRequests} requests, ${result.summary.popularity + result.summary.heat + result.summary.hotness} total worlds, ${totalUsers} users\n`;
            fs.appendFileSync(path.join('data', 'fetch_log.txt'), logEntry);

            console.log(`✅ Fetch completed: ${dailyData.worlds.length} worlds and ${totalUsers} users saved to ${dailyFilePath}`);
            
            if (hasErrors) {
                console.log('Fetch completed with some errors - check individual results');
            }

            // Send daily data email based on timing requirements
            try {
                if (dailyData.worlds.length > 0) {
                    const currentDate = startTime.toISOString().split('T')[0];
                    const lastEmailDate = this.lastEmailSent ? this.lastEmailSent.toISOString().split('T')[0] : null;
                    
                    // Check if this is the first ever fetch
                    if (this.isFirstFetch && !this.firstFetchTime) {
                        this.firstFetchTime = new Date();
                        this.isFirstFetch = false;
                        this.saveFirstFetchState(); // Persist the state
                        
                        // Send immediate email for first fetch for testing purposes
                        console.log('🎉 First fetch detected - sending immediate test email...');
                        await this.sendDailyDataEmail(startTime, true); // true = isFirstFetch
                        
                    } else if (!this.manualTrigger && this.firstFetchTime) {
                        // For subsequent fetches, only send after 24 hours have passed since first fetch
                        const hoursSinceFirstFetch = (Date.now() - this.firstFetchTime.getTime()) / (1000 * 60 * 60);
                        
                        if (hoursSinceFirstFetch >= 24 && currentDate !== lastEmailDate) {
                            console.log(`📅 24+ hours since first fetch - sending daily analytics email...`);
                            await this.sendDailyDataEmail(startTime, false); // false = not first fetch
                        } else if (hoursSinceFirstFetch < 24) {
                            console.log(`⏰ Only ${hoursSinceFirstFetch.toFixed(1)} hours since first fetch - waiting for 24 hour mark`);
                        }
                    }
                }
            } catch (emailError) {
                console.error('Failed to send daily data email:', emailError.message);
                // Don't fail the entire fetch process due to email issues
            }

        } catch (error) {
            console.error('Fetch failed with unhandled error:', error.message);
            
            // For automatic runs, schedule a retry
            if (!this.manualTrigger) {
                console.log('Scheduling retry in 15 minutes due to unhandled error...');
                setTimeout(() => {
                    console.log('Retrying fetch after unhandled error...');
                    this.fetchAllData().catch(console.error);
                }, 900000); // 15 minutes
            }
        } finally {
            this.isRunning = false;
            this.manualTrigger = false;
            const duration = Date.now() - startTime.getTime();
            console.log(`Fetch process completed in ${duration}ms`);
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

    // Email functionality
    initializeEmail() {
        try {
            this.transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: this.emailConfig.from,
                    pass: this.emailConfig.appPassword
                }
            });
            console.log('Email transporter initialized');
            
            // Load any unsent data from previous runs
            this.loadUnsentDataQueue();
            
            // Send startup notification (with error handling)
            this.sendStartupNotification().catch(error => {
                console.log('Startup notification will be retried later due to:', error.message);
            });
            
            // Schedule daily emails (every 24 hours)
            this.scheduleDailyEmails();
            
        } catch (error) {
            console.error('Failed to initialize email:', error.message);
        }
    }

    async sendStartupNotification() {
        try {
            const subject = 'VRChat Fetcher - Server Started';
            const html = `
                <h2>VRChat Fetcher Notification</h2>
                <p>The VRChat Fetcher server has started successfully at ${new Date().toISOString()}.</p>
                <p><strong>Status:</strong></p>
                <ul>
                    <li>Username configured: ${!!this.credentials.username}</li>
                    <li>Password configured: ${!!this.credentials.password}</li>
                    <li>Email configured: ${!!this.emailConfig.to}</li>
                </ul>
                <p>The service will now begin fetching VRChat data every hour and send daily reports.</p>
            `;

            await this.sendEmail(subject, html);
            console.log('✅ Startup notification email sent');
        } catch (error) {
            console.error('Failed to send startup notification:', error.message);
        }
    }

    async createDailyDataArchive(filePath) {
        return new Promise((resolve, reject) => {
            const archivePath = filePath.replace('.json', '.zip');
            const output = fs.createWriteStream(archivePath);
            const archive = archiver('zip', {
                zlib: { level: 9 } // Maximum compression
            });

            output.on('close', () => {
                const sizeInMB = (archive.pointer() / 1024 / 1024).toFixed(2);
                console.log(`Archive created: ${archivePath} (${sizeInMB} MB)`);
                resolve(archivePath);
            });

            archive.on('error', (err) => {
                reject(err);
            });

            archive.pipe(output);
            archive.file(filePath, { name: path.basename(filePath) });
            archive.finalize();
        });
    }

    async sendDailyDataEmail(date = new Date(), isFirstFetch = false) {
        try {
            const filename = this.getDailyFileName(date);
            const filePath = path.join('daily-data', filename);
            
            if (!fs.existsSync(filePath)) {
                console.log(`No daily data file found for ${date.toISOString().split('T')[0]}`);
                return;
            }

            // Purge data folder before processing
            this.purgeDataFolder();

            // Load data for processing
            const dailyData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            
            // Filter out fake/sample worlds from daily data before analytics
            const filteredWorlds = this.filterFakeWorlds(dailyData.worlds || []);
            const cleanDailyData = {
                ...dailyData,
                worlds: filteredWorlds
            };

            // Create analytics data with nested user details
            const analyticsData = this.createAnalyticsWithNestedUsers(cleanDailyData);
            
            // Generate comprehensive statistics using aggregation logic
            const WorldStatsAggregator = require('./aggregate_stats.js');
            const aggregator = new WorldStatsAggregator({ dataDir: 'daily-data' });
            
            // Get current day's world data for quick stats
            const currentDayStats = this.calculateDayStats(filteredWorlds);
            
            // Create enhanced analytics file
            const analyticsFilePath = filePath.replace('.json', '_analytics.json');
            fs.writeFileSync(analyticsFilePath, JSON.stringify(analyticsData, null, 2));
            
            // Create archive with analytics file
            const archivePath = await this.createDailyDataArchive(analyticsFilePath);
            const stats = fs.statSync(archivePath);
            const sizeInMB = (stats.size / 1024 / 1024).toFixed(2);

            const worldsCount = filteredWorlds.length;
            const usersCount = Object.keys(cleanDailyData.users || {}).length;
            
            // Create detailed statistics HTML
            const statsHtml = this.createStatsHtml(currentDayStats, worldsCount, usersCount);
            
            const subject = isFirstFetch 
                ? `VRChat First Fetch Data - ${cleanDailyData.date}` 
                : `VRChat Daily Analytics - ${cleanDailyData.date}`;
                
            const html = `
                <h2>${isFirstFetch ? 'VRChat First Fetch Report' : 'VRChat Daily Analytics Report'}</h2>
                <p><strong>Date:</strong> ${cleanDailyData.date}</p>
                <p><strong>Last Updated:</strong> ${cleanDailyData.lastUpdated}</p>
                
                ${statsHtml}
                
                <p>The complete analytics data is attached as a ZIP file with user details nested within each world object.</p>
                <p><em>Note: All fake/sample worlds have been filtered out from this report.</em></p>
                <p><em>Data collection timestamp: ${cleanDailyData.lastUpdated}</em></p>
            `;

            await this.sendEmail(subject, html, [{
                filename: path.basename(archivePath),
                path: archivePath
            }]);

            // Clean up temporary files
            fs.unlinkSync(archivePath);
            if (fs.existsSync(analyticsFilePath)) {
                fs.unlinkSync(analyticsFilePath);
            }
            
            console.log(`✅ ${isFirstFetch ? 'First fetch' : 'Daily analytics'} email sent for ${cleanDailyData.date}`);
            this.lastEmailSent = new Date();
            
        } catch (error) {
            console.error('Failed to send daily data email:', error.message);
            // Add to unsent queue for retry
            this.addToUnsentQueue(date);
        }
    }

    /**
     * Calculate statistics for current day's data
     */
    calculateDayStats(worlds) {
        if (!worlds || worlds.length === 0) {
            return {
                totalWorlds: 0,
                avgOccupants: 0,
                maxOccupants: 0,
                minOccupants: 0,
                totalOccupants: 0,
                worldsWithOccupants: 0
            };
        }

        const occupantCounts = worlds.map(world => {
            return world.occupants || world.publicOccupants || world.heat || world.popularity || 0;
        });

        const totalOccupants = occupantCounts.reduce((a, b) => a + b, 0);
        const worldsWithOccupants = occupantCounts.filter(count => count > 0).length;

        return {
            totalWorlds: worlds.length,
            avgOccupants: worlds.length > 0 ? Math.round((totalOccupants / worlds.length) * 100) / 100 : 0,
            maxOccupants: worlds.length > 0 ? Math.max(...occupantCounts) : 0,
            minOccupants: worlds.length > 0 ? Math.min(...occupantCounts) : 0,
            totalOccupants: totalOccupants,
            worldsWithOccupants: worldsWithOccupants
        };
    }

    /**
     * Create detailed statistics HTML for email body
     */
    createStatsHtml(dayStats, worldsCount, usersCount) {
        return `
            <h3>Daily Summary Statistics:</h3>
            <ul>
                <li><strong>Total Worlds (after filtering):</strong> ${worldsCount}</li>
                <li><strong>Unique Users:</strong> ${usersCount}</li>
                <li><strong>Total Occupants Across All Worlds:</strong> ${dayStats.totalOccupants}</li>
                <li><strong>Worlds with Active Occupants:</strong> ${dayStats.worldsWithOccupants}</li>
            </ul>
            
            <h3>Occupancy Statistics:</h3>
            <ul>
                <li><strong>Average Occupants per World:</strong> ${dayStats.avgOccupants}</li>
                <li><strong>Maximum Occupants (Single World):</strong> ${dayStats.maxOccupants}</li>
                <li><strong>Minimum Occupants (Single World):</strong> ${dayStats.minOccupants}</li>
            </ul>
            
            <h3>Data Quality:</h3>
            <ul>
                <li><strong>Fake/Sample Worlds Filtered:</strong> Yes</li>
                <li><strong>User Details:</strong> Nested within world objects</li>
                <li><strong>Data Folder:</strong> Purged before processing</li>
            </ul>
        `;
    }

    async sendEmail(subject, html, attachments = []) {
        if (!this.transporter) {
            throw new Error('Email transporter not initialized');
        }

        const mailOptions = {
            from: this.emailConfig.from,
            to: this.emailConfig.to,
            subject: subject,
            html: html
        };

        if (attachments.length > 0) {
            mailOptions.attachments = attachments;
        }

        return await this.transporter.sendMail(mailOptions);
    }

    addToUnsentQueue(date) {
        const dateString = date.toISOString().split('T')[0];
        if (!this.unsentDataQueue.includes(dateString)) {
            this.unsentDataQueue.push(dateString);
            this.saveUnsentDataQueue();
            console.log(`Added ${dateString} to unsent data queue`);
        }
    }

    saveUnsentDataQueue() {
        const queuePath = path.join('email-queue', 'unsent.json');
        fs.writeFileSync(queuePath, JSON.stringify({
            queue: this.unsentDataQueue,
            lastUpdated: new Date().toISOString()
        }, null, 2));
    }

    loadUnsentDataQueue() {
        try {
            const queuePath = path.join('email-queue', 'unsent.json');
            if (fs.existsSync(queuePath)) {
                const data = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
                this.unsentDataQueue = data.queue || [];
                console.log(`Loaded ${this.unsentDataQueue.length} unsent data entries from queue`);
                
                // Retry sending unsent data
                this.retryUnsentEmails();
            }
        } catch (error) {
            console.error('Failed to load unsent data queue:', error.message);
            this.unsentDataQueue = [];
        }
    }

    async retryUnsentEmails() {
        if (this.unsentDataQueue.length === 0) return;
        
        console.log(`Retrying ${this.unsentDataQueue.length} unsent emails...`);
        
        for (const dateString of [...this.unsentDataQueue]) {
            try {
                const date = new Date(dateString);
                await this.sendDailyDataEmail(date);
                
                // Remove from queue if successful
                this.unsentDataQueue = this.unsentDataQueue.filter(d => d !== dateString);
                this.saveUnsentDataQueue();
                console.log(`✅ Successfully sent email for ${dateString}`);
                
                // Add delay between retries
                await this.sleep(2000);
                
            } catch (error) {
                console.error(`Failed to retry email for ${dateString}:`, error.message);
                // Keep in queue for next retry
            }
        }
        
        if (this.unsentDataQueue.length > 0) {
            console.log(`${this.unsentDataQueue.length} emails still pending retry`);
        } else {
            console.log('All unsent emails have been successfully sent');
        }
    }

    scheduleDailyEmails() {
        // Send daily email every 24 hours
        const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
        
        setInterval(() => {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            this.sendDailyDataEmail(yesterday);
        }, TWENTY_FOUR_HOURS);
        
        console.log('Daily email scheduler initialized (every 24 hours)');
    }

    saveAuthRetryState() {
        try {
            const statePath = path.join('auth-retry', 'state.json');
            fs.writeFileSync(statePath, JSON.stringify({
                ...this.authRetryState,
                lastUpdated: new Date().toISOString()
            }, null, 2));
        } catch (error) {
            console.error('Failed to save auth retry state:', error.message);
        }
    }

    loadAuthRetryState() {
        try {
            const statePath = path.join('auth-retry', 'state.json');
            if (fs.existsSync(statePath)) {
                const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                this.authRetryState = {
                    retryCount: data.retryCount || 0,
                    lastAttempt: data.lastAttempt ? new Date(data.lastAttempt) : null,
                    nextAllowedAttempt: data.nextAllowedAttempt ? new Date(data.nextAllowedAttempt) : null,
                    maxRetries: data.maxRetries || 5
                };
                console.log(`Loaded auth retry state: ${this.authRetryState.retryCount}/${this.authRetryState.maxRetries} attempts`);
                
                // Check if we're still in backoff period
                if (this.authRetryState.nextAllowedAttempt && new Date() < this.authRetryState.nextAllowedAttempt) {
                    const waitTime = Math.round((this.authRetryState.nextAllowedAttempt - new Date()) / 1000);
                    console.log(`⚠️  Authentication backoff active - next attempt allowed in ${waitTime} seconds`);
                }
            } else {
                console.log('No previous auth retry state found - starting fresh');
            }
        } catch (error) {
            console.error('Failed to load auth retry state:', error.message);
            this.authRetryState = {
                retryCount: 0,
                lastAttempt: null,
                nextAllowedAttempt: null,
                maxRetries: 5
            };
        }
    }

    resetAuthRetryState() {
        this.authRetryState = {
            retryCount: 0,
            lastAttempt: null,
            nextAllowedAttempt: null,
            maxRetries: 5
        };
        this.saveAuthRetryState();
        console.log('✅ Auth retry state reset after successful authentication');
    }

    saveFirstFetchState() {
        try {
            const statePath = path.join('auth-retry', 'first-fetch-state.json');
            fs.writeFileSync(statePath, JSON.stringify({
                isFirstFetch: this.isFirstFetch,
                firstFetchTime: this.firstFetchTime ? this.firstFetchTime.toISOString() : null,
                lastUpdated: new Date().toISOString()
            }, null, 2));
        } catch (error) {
            console.error('Failed to save first fetch state:', error.message);
        }
    }

    loadFirstFetchState() {
        try {
            const statePath = path.join('auth-retry', 'first-fetch-state.json');
            if (fs.existsSync(statePath)) {
                const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                this.isFirstFetch = data.isFirstFetch !== false; // Default to true if not set
                this.firstFetchTime = data.firstFetchTime ? new Date(data.firstFetchTime) : null;
                
                if (this.firstFetchTime) {
                    const hoursSinceFirst = (Date.now() - this.firstFetchTime.getTime()) / (1000 * 60 * 60);
                    console.log(`📅 Loaded first fetch state: ${this.firstFetchTime.toISOString()} (${hoursSinceFirst.toFixed(1)} hours ago)`);
                } else {
                    console.log('📅 No previous first fetch recorded - will treat next fetch as first');
                }
            } else {
                console.log('📅 No first fetch state found - this will be treated as first fetch');
            }
        } catch (error) {
            console.error('Failed to load first fetch state:', error.message);
            this.isFirstFetch = true;
            this.firstFetchTime = null;
        }
    }

    canAttemptAuth() {
        const now = new Date();
        
        // Check if we've exceeded max retries
        if (this.authRetryState.retryCount >= this.authRetryState.maxRetries) {
            console.error(`❌ Maximum authentication retries (${this.authRetryState.maxRetries}) exceeded`);
            return false;
        }
        
        // Check if we're still in backoff period
        if (this.authRetryState.nextAllowedAttempt && now < this.authRetryState.nextAllowedAttempt) {
            const waitTime = Math.round((this.authRetryState.nextAllowedAttempt - now) / 1000);
            console.log(`⏳ Authentication backoff active - next attempt allowed in ${waitTime} seconds`);
            return false;
        }
        
        return true;
    }

    updateAuthRetryState(failed = false) {
        const now = new Date();
        this.authRetryState.lastAttempt = now;
        
        if (failed) {
            this.authRetryState.retryCount++;
            
            // Calculate next allowed attempt with exponential backoff
            let waitTime;
            if (this.authRetryState.retryCount >= this.authRetryState.maxRetries) {
                // Max retries reached - no more attempts allowed
                waitTime = null;
                this.authRetryState.nextAllowedAttempt = null;
            } else {
                // Exponential backoff: 30s, 60s, 120s, 240s, 300s (cap at 5 minutes)
                waitTime = Math.min(30000 * Math.pow(2, this.authRetryState.retryCount - 1), 300000);
                this.authRetryState.nextAllowedAttempt = new Date(now.getTime() + waitTime);
            }
            
            console.log(`❌ Authentication failed (attempt ${this.authRetryState.retryCount}/${this.authRetryState.maxRetries})`);
            if (waitTime) {
                console.log(`⏳ Next attempt allowed in ${waitTime / 1000} seconds`);
            }
        }
        
        this.saveAuthRetryState();
    }

    start() {
        console.log('VRChat Fetcher started');
        console.log('Environment check:');
        console.log('- Username set:', !!this.credentials.username);
        console.log('- Password set:', !!this.credentials.password);
        
        // Don't authenticate immediately, let the first fetch handle it with retry logic
        console.log('Authentication will be handled on first fetch attempt');
        
        // Schedule hourly fetches
        const runFetch = () => {
            this.fetchAllData().catch(error => {
                console.error('Scheduled fetch error:', error.message);
                // Error handling is now managed within fetchAllData
            });
        };

        // Run immediately if not disabled (with retry logic built in)
        if (process.env.IMMEDIATE_START !== 'false') {
            console.log('Starting initial fetch in 10 seconds...');
            setTimeout(runFetch, 10000); // Wait 10 seconds for server to fully start
        }

        // Schedule every hour
        setInterval(runFetch, 60 * 60 * 1000);
        
        console.log('Scheduled to run every hour with automatic retry on failures');
    }
}

// Start the fetcher
const fetcher = new VRChatFetcher();
fetcher.start();

// Export the class for testing
module.exports = VRChatFetcher;
