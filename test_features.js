#!/usr/bin/env node

// Test script to verify the new features work correctly
const VRChatFetcher = require('./index.js');

// Mock data for testing
const testDailyData = {
    date: "2025-08-14",
    worlds: [
        {
            id: "wrld_12345",
            name: "Sample World 1", // This should be filtered
            authorId: "usr_11111",
            occupants: 5
        },
        {
            id: "wrld_real1",
            name: "Real World",
            authorId: "usr_22222",
            occupants: 10
        },
        {
            id: "wrld_real2", 
            name: "Another Real World",
            authorId: "usr_11111",
            occupants: 15
        }
    ],
    users: {
        "usr_11111": {
            id: "usr_11111",
            displayName: "Test User 1"
        },
        "usr_22222": {
            id: "usr_22222", 
            displayName: "Test User 2"
        }
    }
};

async function testFeatures() {
    console.log('🧪 Testing VRChat Fetcher Enhanced Features');
    console.log('='.repeat(50));
    
    const fetcher = new VRChatFetcher();
    
    // Test 1: Fake world filtering
    console.log('\n1. Testing fake world filtering...');
    const filteredWorlds = fetcher.filterFakeWorlds(testDailyData.worlds);
    console.log(`   Original worlds: ${testDailyData.worlds.length}`);
    console.log(`   After filtering: ${filteredWorlds.length}`);
    console.log(`   Fake worlds removed: ${testDailyData.worlds.length - filteredWorlds.length}`);
    
    // Test 2: User nesting
    console.log('\n2. Testing user detail nesting...');
    const analyticsData = fetcher.createAnalyticsWithNestedUsers(testDailyData);
    console.log(`   Original structure: worlds array + users object`);
    console.log(`   New structure: worlds array with nested author details`);
    console.log(`   Users object removed: ${!analyticsData.users}`);
    console.log(`   Example world with author:`, JSON.stringify(analyticsData.worlds[0], null, 2));
    
    // Test 3: Day statistics calculation
    console.log('\n3. Testing day statistics...');
    const dayStats = fetcher.calculateDayStats(filteredWorlds);
    console.log(`   Total worlds: ${dayStats.totalWorlds}`);
    console.log(`   Average occupants: ${dayStats.avgOccupants}`);
    console.log(`   Max occupants: ${dayStats.maxOccupants}`);
    console.log(`   Min occupants: ${dayStats.minOccupants}`);
    console.log(`   Total occupants: ${dayStats.totalOccupants}`);
    
    // Test 4: Check first fetch state handling
    console.log('\n4. Testing first fetch state...');
    console.log(`   Is first fetch: ${fetcher.isFirstFetch}`);
    console.log(`   First fetch time: ${fetcher.firstFetchTime}`);
    
    console.log('\n✅ All tests completed!');
}

testFeatures().catch(console.error);