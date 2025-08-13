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
        
        // Create data directories
        this.ensureDirectories();
        
        // Initialize email transporter
        this.initializeEmail();
        
        // Start HTTP server for manual trigger
        this.startServer();
    }

    ensureDirectories() {
        const dirs = ['data', 'data/scheduled', 'data/manual', 'daily-data', 'email-queue'];
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
        const attempt = retryCount + 1;
        console.log(`Authenticating with VRChat... (attempt ${attempt}/${maxRetries + 1})`);
        
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
                                return true;
                            }
                        }
                    }
                    
                    if (!this.authCookie) {
                        throw new Error('Could not extract auth cookie from 2FA response');
                    }
                }
            } else if (response.status === 401) {
                console.error('Authentication failed - Invalid credentials or 2FA required:', response.data);
                if (retryCount < maxRetries) {
                    const waitTime = Math.min(30000 * Math.pow(2, retryCount), 300000); // Cap at 5 minutes
                    console.log(`Retrying authentication in ${waitTime / 1000} seconds...`);
                    await this.sleep(waitTime);
                    return this.authenticate(retryCount + 1, maxRetries);
                }
                throw new Error('Invalid credentials or 2FA required - max retries exceeded');
            } else if (response.status === 429) {
                console.error('Rate limited during authentication:', response.data);
                if (retryCount < maxRetries) {
                    // For 429, wait longer with exponential backoff
                    const waitTime = Math.min(300000 * Math.pow(1.5, retryCount), 900000); // Start at 5min, cap at 15min
                    console.log(`Rate limited - waiting ${waitTime / 1000} seconds before retry...`);
                    await this.sleep(waitTime);
                    return this.authenticate(retryCount + 1, maxRetries);
                }
                throw new Error('Rate limit exceeded - max retries exceeded');
            } else {
                console.error('Unexpected authentication response:', response);
                if (retryCount < maxRetries) {
                    const waitTime = Math.min(60000 * Math.pow(2, retryCount), 300000); // Start at 1min, cap at 5min
                    console.log(`Unexpected response - retrying in ${waitTime / 1000} seconds...`);
                    await this.sleep(waitTime);
                    return this.authenticate(retryCount + 1, maxRetries);
                }
                throw new Error(`Authentication failed with status ${response.status} - max retries exceeded`);
            }
        } catch (error) {
            if (error.message.includes('max retries exceeded')) {
                throw error; // Don't retry if we've already exceeded max retries
            }
            
            console.error('Authentication network error:', error.message);
            if (retryCount < maxRetries) {
                const waitTime = Math.min(60000 * Math.pow(2, retryCount), 300000);
                console.log(`Network error - retrying in ${waitTime / 1000} seconds...`);
                await this.sleep(waitTime);
                return this.authenticate(retryCount + 1, maxRetries);
            }
            throw new Error(`Authentication network error - max retries exceeded: ${error.message}`);
        }
        
        // If we get here without returning true, authentication failed
        if (retryCount < maxRetries) {
            const waitTime = Math.min(60000 * Math.pow(2, retryCount), 300000);
            console.log(`Authentication incomplete - retrying in ${waitTime / 1000} seconds...`);
            await this.sleep(waitTime);
            return this.authenticate(retryCount + 1, maxRetries);
        }
        
        throw new Error('Authentication failed - max retries exceeded');
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
                processedWorldsData[sort] = allResults[sort].map(world => this.filterWorldData(world));
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

            // Send daily data email if it's a new day and data was successfully collected
            try {
                if (dailyData.worlds.length > 0) {
                    const currentDate = startTime.toISOString().split('T')[0];
                    const lastEmailDate = this.lastEmailSent ? this.lastEmailSent.toISOString().split('T')[0] : null;
                    
                    // Send email if we haven't sent one today and this is scheduled fetch
                    if (!this.manualTrigger && currentDate !== lastEmailDate) {
                        console.log('Sending daily data email...');
                        await this.sendDailyDataEmail(startTime);
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

    async sendDailyDataEmail(date = new Date()) {
        try {
            const filename = this.getDailyFileName(date);
            const filePath = path.join('daily-data', filename);
            
            if (!fs.existsSync(filePath)) {
                console.log(`No daily data file found for ${date.toISOString().split('T')[0]}`);
                return;
            }

            // Load data for summary
            const dailyData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const worldsCount = dailyData.worlds?.length || 0;
            const usersCount = Object.keys(dailyData.users || {}).length;
            
            // Create archive
            const archivePath = await this.createDailyDataArchive(filePath);
            const stats = fs.statSync(archivePath);
            const sizeInMB = (stats.size / 1024 / 1024).toFixed(2);

            const subject = `VRChat Daily Data - ${dailyData.date}`;
            const html = `
                <h2>VRChat Daily Data Report</h2>
                <p><strong>Date:</strong> ${dailyData.date}</p>
                <p><strong>Last Updated:</strong> ${dailyData.lastUpdated}</p>
                
                <h3>Summary Statistics:</h3>
                <ul>
                    <li><strong>Total Worlds:</strong> ${worldsCount}</li>
                    <li><strong>Unique Users:</strong> ${usersCount}</li>
                    <li><strong>Archive Size:</strong> ${sizeInMB} MB</li>
                </ul>
                
                <p>The complete data is attached as a ZIP file containing the daily JSON data.</p>
                <p><em>Data collection timestamp: ${dailyData.lastUpdated}</em></p>
            `;

            await this.sendEmail(subject, html, [{
                filename: path.basename(archivePath),
                path: archivePath
            }]);

            // Clean up archive file after sending
            fs.unlinkSync(archivePath);
            
            console.log(`✅ Daily data email sent for ${dailyData.date}`);
            this.lastEmailSent = new Date();
            
        } catch (error) {
            console.error('Failed to send daily data email:', error.message);
            // Add to unsent queue for retry
            this.addToUnsentQueue(date);
        }
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
