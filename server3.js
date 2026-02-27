import express from 'express';
import session from 'express-session';
import { 
  saveUser, 
  getUserById,
  getUserByStravaId, 
  getAllUsers, 
  useBailoutPass,
  saveDailyProgress,
  getDailyProgress,
  getConsecutiveMisses,
  eliminateUser,
  calculateAgeGradedPace,
  calculateImprovement,
  getAveragePace,
  updateUserProfile,
  getAgeGradingStats,
  getUserColor  // ADD THIS
} from './database.js';

const app = express();

const STRAVA_CLIENT_ID = '0';
const STRAVA_CLIENT_SECRET = '0';

// Serve static files
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: 'strava-secret-key-12345',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// ============================================
// HELPER FUNCTIONS
// ============================================

// FUNCTION 2: Calculate daily required distance
function getRequiredDistance(date) {
  const month = date.getMonth() + 1; // 1-12
  const day = date.getDate(); // 1-31
  return parseFloat(`${month}.${day.toString().padStart(2, '0')}`);
}

// FUNCTION 3: Check if daily goal was met
function checkDailyGoal(runs, requiredDistance) {
  const totalDistance = runs.reduce((sum, run) => sum + run.distance, 0);
  return {
    totalDistance: totalDistance,
    requiredDistance: requiredDistance,
    goalMet: totalDistance >= requiredDistance,
    shortfall: Math.max(0, requiredDistance - totalDistance)
  };
}

// Get runs for a specific date
function getRunsForDate(activities, date) {
  const dateStr = date.toISOString().split('T')[0];
  
  return activities.filter(activity => {
    const activityDate = new Date(activity.start_date).toISOString().split('T')[0];
    return activityDate === dateStr && (activity.type === 'Run' || activity.type === 'VirtualRun');
  });
}

// Validate streak and check for elimination
function validateStreak(userId, consecutiveMisses) {
  if (consecutiveMisses >= 3) {
    const today = new Date().toISOString().split('T')[0];
    eliminateUser(userId, today, 'Three consecutive missed days');
    return {
      status: 'eliminated',
      reason: 'Three consecutive missed days'
    };
  } else if (consecutiveMisses === 2) {
    return {
      status: 'at_risk',
      reason: 'Two consecutive misses - one more and you\'re eliminated!'
    };
  }
  return {
    status: 'active',
    reason: null
  };
}

// Calculate streak statistics
function calculateStreaks(progressData) {
  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 0;
  
  // Sort by date ascending
  const sorted = [...progressData].sort((a, b) => new Date(a.date) - new Date(b.date));
  
  for (const day of sorted) {
    if (day.status === 'completed' || day.status === 'bailout') {
      tempStreak++;
      longestStreak = Math.max(longestStreak, tempStreak);
    } else if (day.status === 'missed') {
      tempStreak = 0;
    }
  }
  
  // Current streak is from the end
  const reversed = [...sorted].reverse();
  for (const day of reversed) {
    if (day.status === 'completed' || day.status === 'bailout') {
      currentStreak++;
    } else if (day.status === 'missed') {
      break;
    }
  }
  
  return { currentStreak, longestStreak };
}

// Calculate total days run
function getTotalDaysRun(progressData) {
  return progressData.filter(d => d.status === 'completed').length;
}

// Winner determination algorithm
function determineWinner(users, progressDataMap) {
  // Separate active and eliminated users
  const active = users.filter(u => !u.elimination_date);
  const eliminated = users.filter(u => u.elimination_date)
    .sort((a, b) => new Date(b.elimination_date) - new Date(a.elimination_date));
  
  let candidates = active.length > 0 ? active : eliminated;
  
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  
  // Tiebreaker 1: Last to quit (active users win, or latest elimination)
  if (active.length > 0 && eliminated.length > 0) {
    candidates = active;
  }
  
  if (candidates.length === 1) return candidates[0];
  
  // Tiebreaker 2: Total days run
  const withDayCount = candidates.map(u => ({
    ...u,
    totalDaysRun: getTotalDaysRun(progressDataMap[u.id] || [])
  }));
  
  withDayCount.sort((a, b) => b.totalDaysRun - a.totalDaysRun);
  
  if (withDayCount[0].totalDaysRun > withDayCount[1]?.totalDaysRun) {
    return withDayCount[0];
  }
  
  // Tiebreaker 3: Longest streak (simplified, would be pace improvement in full version)
  const withStreaks = withDayCount.map(u => ({
    ...u,
    streaks: calculateStreaks(progressDataMap[u.id] || [])
  }));
  
  withStreaks.sort((a, b) => b.streaks.longestStreak - a.streaks.longestStreak);
  
  return withStreaks[0];
}

// Home page - Public Family Dashboard (REQUIRES LOGIN)
app.get('/', async (req, res) => {
  // Require login
  if (!req.session.userId) {
    return res.redirect('/auth/strava');
  }
  
  const users = getAllUsers();
  
  if (users.length === 0) {
    return res.redirect('/auth/strava');
  }
  
  // FAMILY DASHBOARD
  try {
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    // Challenge start date (adjust to your actual start date)
    const challengeStartDate = new Date('2026-01-01');
    const daysIntoChallenge = Math.floor((today - challengeStartDate) / (1000 * 60 * 60 * 24));
    
    // Today's required distance
    const todayRequired = getRequiredDistance(today);
    
    // Gather stats for all users
    const familyStats = [];
    
    // Data for line charts
    const chartData = {
      dates: [],
      daysCompleted: {}, // userId -> array of cumulative days
      totalMiles: {}, // userId -> array of cumulative miles
      improvement: {} // userId -> array of 7-day avg improvement
    };
    
    // Generate last 30 days
    const dates = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      dates.push(date);
      chartData.dates.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }
    
    let todayCompletedCount = 0;
    let totalDaysCompleted = 0;
    let totalPossibleDays = 0;
    
    for (const user of users) {
      const progressData = getDailyProgress(user.id, thirtyDaysAgo, today);
      const streaks = calculateStreaks(progressData);
      const totalDaysRun = getTotalDaysRun(progressData);
      const consecutiveMisses = getConsecutiveMisses(user.id, today);
      const streakStatus = validateStreak(user.id, consecutiveMisses);
      
      // Calculate total miles
      const totalMiles = progressData
        .filter(d => d.status === 'completed')
        .reduce((sum, d) => sum + d.completed_distance, 0);
      
      // Today's completion
      const todayProgress = progressData.find(d => {
        const progressDate = new Date(d.date);
        return progressDate.toDateString() === today.toDateString();
      });
      
      const todayComplete = todayProgress?.status === 'completed';
      if (todayComplete) todayCompletedCount++;
      
      totalDaysCompleted += totalDaysRun;
      totalPossibleDays += 30; // 30 days per person
      
      // Calculate age-graded improvement from live Strava data
let improvementData = [];
if (user.age && user.sex && user.baseline_mile_pace && user.access_token) {
  try {
    const activitiesResponse = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=200', {
      headers: { 'Authorization': `Bearer ${user.access_token}` }
    });
    const activitiesData = await activitiesResponse.json();

    // Guard against Strava returning an error object instead of an array
    // (happens when token is expired, rate limited, or unauthorized)
    if (!Array.isArray(activitiesData)) {
      console.error(`Strava API error for ${user.firstname}:`, activitiesData);
      improvementData = new Array(dates.length).fill(null);
    } else {
      const activities = activitiesData;

      // Build improvement data for each day
      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const sevenDaysAgo = new Date(date);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // Get runs in 7-day window
        const windowRuns = activities.filter(a => {
          if (a.type !== 'Run' && a.type !== 'VirtualRun') return false;
          const runDate = new Date(a.start_date);
          return runDate >= sevenDaysAgo && runDate <= date && a.distance > 0;
        });

        if (windowRuns.length > 0) {
          const avgPace = windowRuns.reduce((sum, run) => {
            const miles = run.distance * 0.000621371;
            const pace = run.moving_time / 60 / miles;
            return sum + pace;
          }, 0) / windowRuns.length;

          const improvement = calculateImprovement(avgPace, user.baseline_mile_pace, user.age, user.sex) || 0;
          improvementData.push(improvement);
        } else {
          improvementData.push(null);
        }
      }
    }
  } catch (error) {
    console.error(`Error fetching activities for ${user.firstname}:`, error);
    improvementData = new Array(dates.length).fill(null);
  }
}
      
      // Build cumulative days and miles data for charts
      let cumulativeDays = 0;
      let cumulativeMiles = 0;
      const userDaysData = [];
      const userMilesData = [];
      
      dates.forEach(date => {
        const dateStr = date.toISOString().split('T')[0];
        const dayProgress = progressData.find(p => p.date === dateStr);
        
        if (dayProgress && dayProgress.status === 'completed') {
          cumulativeDays++;
          cumulativeMiles += dayProgress.completed_distance;
        }
        
        userDaysData.push(cumulativeDays);
        userMilesData.push(parseFloat(cumulativeMiles.toFixed(2)));
      });
      
      chartData.daysCompleted[user.id] = userDaysData;
      chartData.totalMiles[user.id] = userMilesData;
      chartData.improvement[user.id] = improvementData;
      
      familyStats.push({
        id: user.id,
        name: `${user.firstname} ${user.lastname}`,
        firstname: user.firstname,
        totalDaysRun,
        totalMiles,
        currentStreak: streaks.currentStreak,
        longestStreak: streaks.longestStreak,
        bailoutPasses: user.bailout_passes,
        consecutiveMisses,
        status: streakStatus.status,
        eliminated: !!user.elimination_date,
        eliminationDate: user.elimination_date,
        todayComplete,
        color: getUserColor(user.id)
      });
    }
    
    // Sort by total days run
    const rankedStats = [...familyStats].sort((a, b) => {
      if (a.eliminated && !b.eliminated) return 1;
      if (!a.eliminated && b.eliminated) return -1;
      return b.totalDaysRun - a.totalDaysRun;
    });
    
    // Overall completion rate
    const overallCompletionRate = totalPossibleDays > 0 
      ? ((totalDaysCompleted / totalPossibleDays) * 100).toFixed(1)
      : 0;
    
    // Prepare chart datasets
    const daysDatasets = familyStats.map(user => ({
      label: user.firstname,
      data: chartData.daysCompleted[user.id],
      borderColor: user.color,
      backgroundColor: user.color,
      tension: 0.3
    }));
    
    const milesDatasets = familyStats.map(user => ({
      label: user.firstname,
      data: chartData.totalMiles[user.id],
      borderColor: user.color,
      backgroundColor: user.color,
      tension: 0.3
    }));
    
    const improvementDatasets = familyStats.map(user => ({
      label: user.firstname,
      data: chartData.improvement[user.id],
      borderColor: user.color,
      backgroundColor: user.color,
      tension: 0.3,
      spanGaps: true
    }));
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Zhou Family Running Challenge - Dashboard</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: #f5f5f5;
            min-height: 100vh;
            padding: 20px;
          }
          
          .container { 
            max-width: 1400px; 
            margin: 0 auto; 
          }
          
          .header {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
            margin-bottom: 30px;
            text-align: center;
          }
          
          .header h1 {
            font-size: 42px;
            color: #333;
            margin-bottom: 10px;
          }
          
          .header .subtitle {
            font-size: 16px;
            color: #666;
          }
          
          .quick-stats {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 15px;
            margin-bottom: 30px;
          }
          
          .quick-stat {
            background: white;
            padding: 25px;
            border-radius: 10px;
            text-align: center;
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
            border-top: 4px solid #FC5200;
          }
          
          .quick-stat .number {
            font-size: 36px;
            font-weight: bold;
            color: #FC5200;
          }
          
          .quick-stat .label {
            color: #666;
            font-size: 14px;
            margin-top: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          
          .card {
            background: white;
            border-radius: 10px;
            padding: 25px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
            margin-bottom: 20px;
          }
          
          .card h2 {
            color: #333;
            margin-bottom: 20px;
            font-size: 20px;
            border-bottom: 3px solid #FC5200;
            padding-bottom: 10px;
          }
          
          .leaderboard-item {
            display: flex;
            align-items: center;
            padding: 15px;
            margin: 10px 0;
            background: #f8f9fa;
            border-radius: 8px;
          }
          
          .leaderboard-item.eliminated {
            opacity: 0.6;
          }
          
          .color-badge {
            width: 8px;
            height: 40px;
            border-radius: 4px;
            margin-right: 15px;
          }
          
          .rank {
            font-size: 24px;
            font-weight: bold;
            color: #FC5200;
            min-width: 40px;
          }
          
          .rank.gold { color: #ffd700; }
          .rank.silver { color: #c0c0c0; }
          .rank.bronze { color: #cd7f32; }
          
          .player-info {
            flex: 1;
            margin-left: 15px;
          }
          
          .player-name {
            font-size: 18px;
            font-weight: bold;
            color: #333;
          }
          
          .player-stats {
            font-size: 14px;
            color: #666;
            margin-top: 5px;
          }
          
          .badge {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
            margin-left: 5px;
          }
          
          .badge.eliminated { background: #f8d7da; color: #721c24; }
          .badge.at-risk { background: #fff3cd; color: #856404; }
          .badge.active { background: #d4edda; color: #155724; }
          
          .charts-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
          }
          
          .chart-container {
            position: relative;
            height: 300px;
          }
          
          .actions {
            display: flex;
            gap: 15px;
            justify-content: center;
            margin-top: 30px;
            flex-wrap: wrap;
          }
          
          .btn {
            padding: 12px 24px;
            background: #FC5200;
            color: white;
            border: 2px solid #FC5200;
            border-radius: 8px;
            text-decoration: none;
            font-weight: bold;
            transition: all 0.3s;
          }
          
          .btn:hover {
            background: #e04800;
            border-color: #e04800;
          }
          
          .btn.secondary {
            background: white;
            color: #FC5200;
          }
          
          .btn.secondary:hover {
            background: #FC5200;
            color: white;
          }
          
          .powered-by {
            text-align: center;
            color: #999;
            margin-top: 30px;
            font-size: 12px;
          }
          
          @media (max-width: 1200px) {
            .quick-stats {
              grid-template-columns: repeat(2, 1fr);
            }
            .charts-grid {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🏃 Zhou Family Running Challenge</h1>
            <div class="subtitle">Family Dashboard · Real-Time Progress</div>
          </div>
          
          <div class="quick-stats">
            <div class="quick-stat">
              <div class="number">Day ${daysIntoChallenge > 0 ? daysIntoChallenge : 1}</div>
              <div class="label">Days Completed</div>
            </div>
            <div class="quick-stat">
              <div class="number">${todayRequired.toFixed(2)} mi</div>
              <div class="label">Today's Required</div>
            </div>
            <div class="quick-stat">
              <div class="number">${todayCompletedCount}/${familyStats.length}</div>
              <div class="label">Today's Completion</div>
            </div>
            <div class="quick-stat">
              <div class="number">${overallCompletionRate}%</div>
              <div class="label">Completion Rate</div>
            </div>
          </div>
          
          <div class="card">
            <h2>🏆 Current Rankings</h2>
            ${rankedStats.map((stat, index) => {
              const medals = ['gold', 'silver', 'bronze'];
              const rankClass = index < 3 && !stat.eliminated ? medals[index] : '';
              const rankDisplay = index + 1;
              
              let statusBadge = '';
              if (stat.eliminated) {
                statusBadge = '<span class="badge eliminated">Eliminated</span>';
              } else if (stat.status === 'at_risk') {
                statusBadge = '<span class="badge at-risk">At Risk</span>';
              } else {
                statusBadge = '<span class="badge active">Active</span>';
              }
              
              return `
                <div class="leaderboard-item ${stat.eliminated ? 'eliminated' : ''}">
                  <div class="color-badge" style="background: ${stat.color};"></div>
                  <div class="rank ${rankClass}">#${rankDisplay}</div>
                  <div class="player-info">
                    <div class="player-name">${stat.name} ${statusBadge}</div>
                    <div class="player-stats">
                      ${stat.totalDaysRun} days · ${stat.totalMiles.toFixed(1)} mi · 
                      ${stat.currentStreak} day streak · 
                      ${stat.bailoutPasses} passes
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          
          <div class="charts-grid">
            <div class="card">
              <h2>📊 Days Completed (Last 30 Days)</h2>
              <div class="chart-container">
                <canvas id="daysChart"></canvas>
              </div>
            </div>
            
            <div class="card">
              <h2>🏃 Total Miles (Last 30 Days)</h2>
              <div class="chart-container">
                <canvas id="milesChart"></canvas>
              </div>
            </div>
            
            <div class="card">
              <h2>📈 Age-Graded Improvement</h2>
              <div class="chart-container">
                <canvas id="improvementChart"></canvas>
              </div>
              <p style="text-align: center; color: #666; font-size: 11px; margin-top: 10px;">
                7-day rolling average vs. baseline
              </p>
            </div>
          </div>
          
          <div class="actions">
            <a href="/dashboard" class="btn">📊 My Dashboard</a>
            <a href="/leaderboard" class="btn secondary">🏆 Full Leaderboard</a>
            <a href="/logout" class="btn secondary">🚪 Logout</a>
          </div>
          
          <div class="powered-by">Powered by Strava</div>
        </div>
        
        <script>
          const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                display: true,
                position: 'bottom'
              }
            },
            scales: {
              y: {
                beginAtZero: true
              }
            }
          };
          
          // Days completed chart
          new Chart(document.getElementById('daysChart').getContext('2d'), {
            type: 'line',
            data: {
              labels: ${JSON.stringify(chartData.dates)},
              datasets: ${JSON.stringify(daysDatasets)}
            },
            options: {
              ...chartOptions,
              scales: {
                y: {
                  beginAtZero: true,
                  title: {
                    display: true,
                    text: 'Cumulative Days'
                  }
                }
              }
            }
          });
          
          // Miles chart
          new Chart(document.getElementById('milesChart').getContext('2d'), {
            type: 'line',
            data: {
              labels: ${JSON.stringify(chartData.dates)},
              datasets: ${JSON.stringify(milesDatasets)}
            },
            options: {
              ...chartOptions,
              scales: {
                y: {
                  beginAtZero: true,
                  title: {
                    display: true,
                    text: 'Cumulative Miles'
                  }
                }
              }
            }
          });
          
          // Improvement chart
          new Chart(document.getElementById('improvementChart').getContext('2d'), {
            type: 'line',
            data: {
              labels: ${JSON.stringify(chartData.dates)},
              datasets: ${JSON.stringify(improvementDatasets)}
            },
            options: {
              ...chartOptions,
              scales: {
                y: {
                  title: {
                    display: true,
                    text: 'Improvement %'
                  }
                }
              }
            }
          });
        </script>
      </body>
      </html>
    `;
    
    res.send(html);
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.send('Error loading dashboard: ' + error.message);
  }
});

// Personal dashboard (for logged-in users)
app.get('/dashboard', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  
  const user = getUserById(req.session.userId);
  
  // Check if profile is complete
  if (!user.profile_complete) {
    return res.redirect('/setup-profile');
  }
  
  try {
    // Fetch recent activities to show today's progress
    const response = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=10', {
      headers: {
        'Authorization': `Bearer ${user.access_token}`
      }
    });
    
    const activities = await response.json();
    activities.forEach(a => a.distance = a.distance * 0.000621371);
    
    const today = new Date();
    const todayRequired = getRequiredDistance(today);
    const todayRuns = getRunsForDate(activities, today);
    const todayGoal = checkDailyGoal(todayRuns, todayRequired);
    
    // Get stats
    const consecutiveMisses = getConsecutiveMisses(user.id, today);
    const streakStatus = validateStreak(user.id, consecutiveMisses);
    
    // Get progress data for stats
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const progressData = getDailyProgress(user.id, thirtyDaysAgo, today);
    const streaks = calculateStreaks(progressData);
    const totalDaysRun = getTotalDaysRun(progressData);
    
    // Get age grading stats
    const ageStats = getAgeGradingStats(user.id);
    
    // Build status messages
    const eliminatedBadge = user.elimination_date 
      ? `<div class="alert danger">
           <h3>❌ ELIMINATED</h3>
           <p>Eliminated on ${new Date(user.elimination_date).toLocaleDateString()}</p>
           <p>Reason: ${user.elimination_reason}</p>
         </div>`
      : '';
    
    const riskWarning = streakStatus.status === 'at_risk'
      ? `<div class="alert warning">
           <h3>⚠️ AT RISK OF ELIMINATION</h3>
           <p>${streakStatus.reason}</p>
         </div>`
      : '';
    
    // Today's progress card
    const todayCard = `
      <div class="card ${todayGoal.goalMet ? 'success' : 'warning'}">
        <h3>Today's Progress (${today.toLocaleDateString()})</h3>
        <div class="progress-circle">
          <div class="big-number">${todayGoal.totalDistance.toFixed(2)}</div>
          <div class="label">of ${todayRequired.toFixed(2)} miles</div>
        </div>
        ${todayGoal.goalMet 
          ? '<p class="success-text">✅ Goal Met!</p>' 
          : `<p class="warning-text">⚠️ Need ${todayGoal.shortfall.toFixed(2)} more miles</p>`
        }
        <p>${todayRuns.length} run(s) today</p>
      </div>
    `;
    
    // Age grading card
    const ageGradingCard = ageStats ? `
      <div class="card">
        <h3>📈 Age-Graded Performance</h3>
        <div class="stat-row">
          <span class="stat-label">Your Age</span>
          <span class="stat-value">${ageStats.age} (${ageStats.sex})</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Baseline Pace</span>
          <span class="stat-value">${Math.floor(ageStats.baselinePace)}:${Math.round((ageStats.baselinePace % 1) * 60).toString().padStart(2, '0')}/mi</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Current Avg Pace</span>
          <span class="stat-value">${Math.floor(ageStats.currentAvgPace)}:${Math.round((ageStats.currentAvgPace % 1) * 60).toString().padStart(2, '0')}/mi</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Improvement</span>
          <span class="stat-value" style="color: ${ageStats.improvement > 0 ? '#28a745' : '#dc3545'}">
            ${ageStats.improvement > 0 ? '+' : ''}${ageStats.improvement.toFixed(1)}%
          </span>
        </div>
      </div>
    ` : '';
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${user.firstname}'s Dashboard</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: #f5f5f5;
            padding: 20px;
          }
          .container { max-width: 1200px; margin: 0 auto; }
          
          header {
            background: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          
          header h1 { color: #333; margin-bottom: 10px; }
          
          .alert {
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            border-left: 5px solid;
          }
          .alert.danger {
            background: #f8d7da;
            border-color: #dc3545;
            color: #721c24;
          }
          .alert.warning {
            background: #fff3cd;
            border-color: #ffc107;
            color: #856404;
          }
          .alert h3 { margin-bottom: 10px; }
          
          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
          }
          
          .card {
            background: white;
            padding: 25px;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          
          .card.success {
            border-left: 5px solid #28a745;
          }
          
          .card.warning {
            border-left: 5px solid #ffc107;
          }
          
          .card h3 {
            color: #333;
            margin-bottom: 15px;
            font-size: 16px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          
          .stat-row {
            display: flex;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid #eee;
          }
          
          .stat-row:last-child {
            border-bottom: none;
          }
          
          .stat-label {
            color: #666;
            font-size: 14px;
          }
          
          .stat-value {
            font-weight: bold;
            font-size: 18px;
            color: #333;
          }
          
          .progress-circle {
            text-align: center;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
            margin: 15px 0;
          }
          
          .big-number {
            font-size: 48px;
            font-weight: bold;
            color: #FC5200;
          }
          
          .label {
            color: #666;
            font-size: 14px;
            margin-top: 5px;
          }
          
          .success-text {
            color: #28a745;
            font-weight: bold;
            text-align: center;
            margin: 10px 0;
          }
          
          .warning-text {
            color: #ffc107;
            font-weight: bold;
            text-align: center;
            margin: 10px 0;
          }
          
          .nav-buttons {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin: 20px 0;
          }
          
          .btn {
            display: block;
            padding: 15px 20px;
            background: #FC5200;
            color: white;
            text-align: center;
            text-decoration: none;
            border-radius: 8px;
            font-weight: bold;
            transition: background 0.3s;
          }
          
          .btn:hover {
            background: #e04800;
          }
          
          .btn.secondary {
            background: #6c757d;
          }
          
          .btn.secondary:hover {
            background: #5a6268;
          }
          
          .powered-by {
            text-align: center;
            color: #999;
            font-size: 12px;
            margin-top: 40px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <header>
            <h1>🏃 Welcome back, ${user.firstname}!</h1>
            <p style="color: #666;">Your Personal Dashboard</p>
          </header>
          
          ${eliminatedBadge}
          ${riskWarning}
          
          <div class="grid">
            ${todayCard}
            
            <div class="card">
              <h3>📊 Challenge Stats</h3>
              <div class="stat-row">
                <span class="stat-label">Days Completed</span>
                <span class="stat-value">${totalDaysRun}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">Current Streak</span>
                <span class="stat-value">${streaks.currentStreak} days</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">Longest Streak</span>
                <span class="stat-value">${streaks.longestStreak} days</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">Consecutive Misses</span>
                <span class="stat-value" style="color: ${consecutiveMisses >= 2 ? '#dc3545' : '#333'}">${consecutiveMisses}</span>
              </div>
            </div>
            
            ${ageGradingCard}
            
            <div class="card">
              <h3>🎫 Resources</h3>
              <div class="stat-row">
                <span class="stat-label">Bailout Passes</span>
                <span class="stat-value">${user.bailout_passes} / 4</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">Status</span>
                <span class="stat-value">${streakStatus.status.toUpperCase()}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">Member Since</span>
                <span class="stat-value">${new Date(user.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
          
          <div class="nav-buttons">
            <a href="/" class="btn">🏠 Family Dashboard</a>
            <a href="/activities" class="btn">📋 My Activities</a>
            <a href="/progress" class="btn">📈 Daily Progress</a>
            <a href="/calendar" class="btn">📅 Calendar</a>
            <a href="/stats" class="btn">📊 Detailed Stats</a>
            <a href="/logout" class="btn secondary">🚪 Logout</a>
          </div>
          
          <div class="powered-by">
            Powered by Strava
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Dashboard error:', error);
    res.send('Error loading dashboard: ' + error.message);
  }
});

// Profile setup page (GET)
app.get('/setup-profile', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  
  const user = getUserById(req.session.userId);
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Complete Your Profile</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          max-width: 600px; 
          margin: 50px auto; 
          padding: 20px;
          background: #f5f5f5;
        }
        .card {
          background: white;
          padding: 40px;
          border-radius: 10px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 { color: #333; margin-bottom: 10px; }
        .subtitle { color: #666; margin-bottom: 30px; }
        .form-group {
          margin-bottom: 20px;
        }
        label {
          display: block;
          font-weight: bold;
          margin-bottom: 5px;
          color: #333;
        }
        input, select {
          width: 100%;
          padding: 12px;
          border: 2px solid #ddd;
          border-radius: 5px;
          font-size: 16px;
          box-sizing: border-box;
        }
        input:focus, select:focus {
          outline: none;
          border-color: #667eea;
        }
        .help-text {
          font-size: 14px;
          color: #666;
          margin-top: 5px;
        }
        .btn {
          width: 100%;
          padding: 15px;
          background: #667eea;
          color: white;
          border: none;
          border-radius: 5px;
          font-size: 16px;
          font-weight: bold;
          cursor: pointer;
          margin-top: 20px;
        }
        .btn:hover {
          background: #5568d3;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>👋 Welcome, ${user.firstname}!</h1>
        <p class="subtitle">Let's set up age-graded performance tracking</p>
        
        <form action="/setup-profile" method="POST">
          <div class="form-group">
            <label>Age</label>
            <input type="number" name="age" min="10" max="100" required value="${user.age || ''}">
            <div class="help-text">Your current age</div>
          </div>
          
          <div class="form-group">
            <label>Sex</label>
            <select name="sex" required>
              <option value="">Select...</option>
              <option value="M" ${user.sex === 'M' ? 'selected' : ''}>Male</option>
              <option value="F" ${user.sex === 'F' ? 'selected' : ''}>Female</option>
            </select>
            <div class="help-text">For age-grading calculations</div>
          </div>
          
          <div class="form-group">
            <label>Baseline Mile Pace</label>
            <input 
              type="number" 
              name="baseline_pace" 
              step="0.1" 
              min="5" 
              max="15" 
              required 
              value="${user.baseline_mile_pace || ''}"
              placeholder="8.5"
            >
            <div class="help-text">
              Your typical mile pace in minutes (e.g., 8.5 = 8:30/mile)<br>
              This is used to track your improvement over time
            </div>
          </div>
          
          <button type="submit" class="btn">Save & Continue</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// Profile setup submission (POST)
app.post('/setup-profile', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  
  const { age, sex, baseline_pace } = req.body;
  
  updateUserProfile(
    req.session.userId, 
    parseInt(age), 
    sex, 
    parseFloat(baseline_pace)
  );
  
  console.log(`Profile completed for user ${req.session.userId}: Age ${age}, ${sex}, ${baseline_pace} min/mile`);
  
  res.redirect('/dashboard');
});

// OAuth routes
app.get('/auth/strava', (req, res) => {
  const redirectUri = 'http://localhost:3000/auth/strava/callback';
  const scope = 'read,activity:read_all';
  
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&approval_prompt=force`;
  
  res.redirect(authUrl);
});

app.get('/auth/strava/callback', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    return res.send('Error: No authorization code received');
  }
  
  try {
    const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code'
      })
    });
    
    const tokenData = await tokenResponse.json();
    const userId = saveUser(tokenData);
    req.session.userId = userId;
    
    console.log(`User ${tokenData.athlete.firstname} connected! User ID: ${userId}`);
    
    res.redirect('/');
  } catch (error) {
    console.error('Auth error:', error);
    res.send('Error during authentication: ' + error.message);
  }
});

// Activities page (keep your detailed version)
app.get('/activities', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  
  const user = getUserById(req.session.userId);
  
  try {
    const response = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=30', {
      headers: {
        'Authorization': `Bearer ${user.access_token}`
      }
    });
    
    const activities = await response.json();
    const runs = activities.filter(a => a.type === 'Run' || a.type === 'VirtualRun');
    
    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${user.firstname}'s Activities</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 900px; margin: 50px auto; padding: 20px; background: #f5f5f5; }
          h1 { color: #333; }
          .header { background: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .activity { 
            background: white;
            border: 1px solid #ddd; 
            padding: 20px; 
            margin: 15px 0; 
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .activity h3 { margin-top: 0; color: #333; }
          .stat-row { display: flex; gap: 30px; flex-wrap: wrap; margin: 10px 0; }
          .stat { 
            flex: 1;
            min-width: 200px;
            padding: 10px;
            background: #f8f9fa;
            border-radius: 5px;
          }
          .stat strong { display: block; color: #666; font-size: 12px; margin-bottom: 5px; }
          .view-strava { 
            display: inline-block;
            margin-top: 15px;
            padding: 10px 20px;
            background: #FC5200;
            color: white;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
          }
          .view-strava:hover { background: #e04800; }
          .back-link { margin-top: 30px; text-align: center; }
          .back-link a { color: #FC5200; text-decoration: none; font-weight: bold; }
          .powered-by { margin-top: 40px; font-size: 12px; color: #666; text-align: center; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>📋 ${user.firstname}'s Recent Runs</h1>
          <p>Total runs found: ${runs.length}</p>
        </div>
    `;
    
    if (runs.length === 0) {
      html += '<div class="activity"><p>No runs found. Go for a run and sync your Strava!</p></div>';
    } else {
      runs.forEach(run => {
        const distanceMiles = (run.distance * 0.000621371).toFixed(2);
        const distanceKm = (run.distance / 1000).toFixed(2);
        const durationMinutes = Math.floor(run.moving_time / 60);
        const durationSeconds = run.moving_time % 60;
        const pace = run.moving_time / 60 / (run.distance * 0.000621371);
        const paceMin = Math.floor(pace);
        const paceSec = Math.floor((pace - paceMin) * 60);
        const speedMph = ((run.distance * 0.000621371) / (run.moving_time / 3600)).toFixed(2);
        const elevationFeet = (run.total_elevation_gain * 3.28084).toFixed(0);
        const elevationMeters = run.total_elevation_gain.toFixed(0);
        const activityUrl = `https://www.strava.com/activities/${run.id}`;
        const runDate = new Date(run.start_date);
        
        html += `
          <div class="activity">
            <h3>${run.name}</h3>
            <p style="color: #666; margin-bottom: 15px;">📅 ${runDate.toLocaleDateString()} at ${runDate.toLocaleTimeString()}</p>
            
            <div class="stat-row">
              <div class="stat">
                <strong>📏 DISTANCE</strong>
                ${distanceMiles} mi (${distanceKm} km)
              </div>
              <div class="stat">
                <strong>⏱️ DURATION</strong>
                ${durationMinutes}:${durationSeconds.toString().padStart(2, '0')}
              </div>
            </div>
            
            <div class="stat-row">
              <div class="stat">
                <strong>🏃 PACE</strong>
                ${paceMin}:${paceSec.toString().padStart(2, '0')} min/mile
              </div>
              <div class="stat">
                <strong>⚡ SPEED</strong>
                ${speedMph} mph
              </div>
            </div>
            
            <div class="stat-row">
              <div class="stat">
                <strong>⛰️ ELEVATION</strong>
                ${elevationFeet} ft (${elevationMeters} m)
              </div>
              <div class="stat">
                <strong>❤️ AVG HEART RATE</strong>
                ${run.average_heartrate ? Math.round(run.average_heartrate) + ' bpm' : 'N/A'}
              </div>
            </div>
            
            ${run.average_cadence ? `
              <div class="stat-row">
                <div class="stat">
                  <strong>👟 CADENCE</strong>
                  ${Math.round(run.average_cadence * 2)} spm
                </div>
              </div>
            ` : ''}
            
            <a href="${activityUrl}" target="_blank" class="view-strava">View on Strava →</a>
          </div>
        `;
      });
    }
    
    html += `
        <div class="back-link">
          <a href="/">← Back to Dashboard</a>
        </div>
        
        <div class="powered-by">
          Powered by Strava
        </div>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Activities error:', error);
    res.send('Error getting activities: ' + error.message);
  }
});

// Daily Progress page
app.get('/progress', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  
  const user = getUserById(req.session.userId);
  
  try {
    const response = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=200', {
      headers: {
        'Authorization': `Bearer ${user.access_token}`
      }
    });
    
    const activities = await response.json();
    activities.forEach(a => a.distance = a.distance * 0.000621371);
    
    const days = [];
    const today = new Date();
    
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      
      const requiredDistance = getRequiredDistance(date);
      const runsForDay = getRunsForDate(activities, date);
      const goalCheck = checkDailyGoal(runsForDay, requiredDistance);
      
      let status;
      const isFuture = date > today;
      const isToday = date.toDateString() === today.toDateString();
      
      if (isFuture) {
        status = 'pending';
      } else if (goalCheck.goalMet) {
        status = 'completed';
      } else if (isToday) {
        status = 'pending';
      } else {
        status = 'missed';
      }
      
      saveDailyProgress(user.id, date, requiredDistance, goalCheck.totalDistance, status);
      
      days.push({
        date: date,
        requiredDistance: requiredDistance,
        runs: runsForDay,
        status: status,
        ...goalCheck
      });
    }
    
    const consecutiveMisses = getConsecutiveMisses(user.id, today);
    const streakStatus = validateStreak(user.id, consecutiveMisses);
    
    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${user.firstname}'s Daily Progress</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 1200px; margin: 50px auto; padding: 20px; background: #f5f5f5; }
          h1 { color: #333; }
          .header { background: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          table { width: 100%; border-collapse: collapse; margin: 20px 0; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          th, td { padding: 15px; text-align: left; border-bottom: 1px solid #ddd; }
          th { background: #f5f5f5; font-weight: bold; position: sticky; top: 0; }
          .met { background-color: #d4edda; }
          .missed { background-color: #f8d7da; }
          .pending { background-color: #fff3cd; }
          .bailout { background-color: #cfe2ff; }
          .back-link { margin-top: 30px; text-align: center; }
          .back-link a { color: #FC5200; text-decoration: none; font-weight: bold; }
          .powered-by { margin-top: 40px; font-size: 12px; color: #666; text-align: center; }
          .summary { background: white; padding: 20px; border-radius: 10px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }
          .summary-item { background: #f8f9fa; padding: 15px; border-radius: 5px; text-align: center; }
          .summary-number { font-size: 32px; font-weight: bold; color: #FC5200; }
          .summary-label { color: #666; font-size: 14px; margin-top: 5px; }
          .warning { background: #fff3cd; padding: 20px; border-radius: 10px; margin: 20px 0; border-left: 5px solid #ffc107; }
          .danger { background: #f8d7da; padding: 20px; border-radius: 10px; margin: 20px 0; border-left: 5px solid #dc3545; }
          .use-bailout { color: #0066cc; text-decoration: none; font-weight: bold; }
          .use-bailout:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>📈 ${user.firstname}'s Daily Progress (Last 30 Days)</h1>
        </div>
    `;
    
    if (streakStatus.status === 'eliminated') {
      html += `
        <div class="danger">
          <h3>❌ ELIMINATED</h3>
          <p>${streakStatus.reason}</p>
        </div>
      `;
    } else if (streakStatus.status === 'at_risk') {
      html += `
        <div class="warning">
          <h3>⚠️ AT RISK OF ELIMINATION</h3>
          <p>${streakStatus.reason}</p>
        </div>
      `;
    }
    
    const daysCompleted = days.filter(d => d.status === 'completed').length;
    const daysMissed = days.filter(d => d.status === 'missed').length;
    const totalMiles = days.reduce((sum, d) => sum + d.totalDistance, 0);
    
    html += `
      <div class="summary">
        <h3>Summary Statistics</h3>
        <div class="summary-grid">
          <div class="summary-item">
            <div class="summary-number">${daysCompleted}</div>
            <div class="summary-label">Days Completed</div>
          </div>
          <div class="summary-item">
            <div class="summary-number">${daysMissed}</div>
            <div class="summary-label">Days Missed</div>
          </div>
          <div class="summary-item">
            <div class="summary-number">${consecutiveMisses}</div>
            <div class="summary-label">Consecutive Misses</div>
          </div>
          <div class="summary-item">
            <div class="summary-number">${user.bailout_passes}</div>
            <div class="summary-label">Bailout Passes Left</div>
          </div>
          <div class="summary-item">
            <div class="summary-number">${totalMiles.toFixed(1)}</div>
            <div class="summary-label">Total Miles Run</div>
          </div>
          <div class="summary-item">
            <div class="summary-number">${((daysCompleted / 30) * 100).toFixed(1)}%</div>
            <div class="summary-label">Success Rate</div>
          </div>
        </div>
      </div>
    `;
    
    html += `
      <table>
        <tr>
          <th>Date</th>
          <th>Required</th>
          <th>Actual</th>
          <th>Runs</th>
          <th>Status</th>
          <th>Shortfall</th>
          <th>Action</th>
        </tr>
    `;
    
    days.forEach(day => {
      const isToday = day.date.toDateString() === today.toDateString();
      const isFuture = day.date > today;
      
      let rowClass = '';
      let status = '';
      let actionButton = '';
      
      if (isFuture) {
        rowClass = 'pending';
        status = 'Future';
      } else if (day.status === 'completed') {
        rowClass = 'met';
        status = '✅ Met';
      } else if (day.status === 'bailout') {
        rowClass = 'bailout';
        status = '🎫 Bailout Used';
      } else if (isToday) {
        rowClass = 'pending';
        status = '⏳ In Progress';
      } else if (day.status === 'missed') {
        rowClass = 'missed';
        status = '❌ Missed';
        
        if (user.bailout_passes > 0) {
          const dateStr = day.date.toISOString().split('T')[0];
          actionButton = `<a href="/use-bailout?date=${dateStr}" class="use-bailout">Use Bailout</a>`;
        }
      }
      
      html += `
        <tr class="${rowClass}">
          <td>${day.date.toLocaleDateString()}</td>
          <td>${day.requiredDistance.toFixed(2)} mi</td>
          <td>${day.totalDistance.toFixed(2)} mi</td>
          <td>${day.runs.length}</td>
          <td><strong>${status}</strong></td>
          <td>${day.shortfall > 0 ? day.shortfall.toFixed(2) + ' mi' : '-'}</td>
          <td>${actionButton}</td>
        </tr>
      `;
    });
    
    html += `
      </table>
      
      <div class="back-link">
        <a href="/">← Back to Dashboard</a>
      </div>
      
      <div class="powered-by">
        Powered by Strava
      </div>
    </body>
    </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Progress error:', error);
    res.send('Error getting progress: ' + error.message);
  }
});

// Use bailout pass
app.get('/use-bailout', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  
  const user = getUserById(req.session.userId);
  const dateStr = req.query.date;
  
  if (!dateStr || user.bailout_passes <= 0) {
    return res.send('Cannot use bailout pass. Either no date specified or no passes remaining.');
  }
  
  useBailoutPass(user.id);
  
  const date = new Date(dateStr);
  const requiredDistance = getRequiredDistance(date);
  saveDailyProgress(user.id, date, requiredDistance, 0, 'bailout');
  
  console.log(`User ${user.firstname} used bailout pass for ${dateStr}`);
  
  res.redirect('/progress');
});

// Calendar View
app.get('/calendar', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  
  const user = getUserById(req.session.userId);
  
  try {
    const response = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=200', {
      headers: {
        'Authorization': `Bearer ${user.access_token}`
      }
    });
    
    const activities = await response.json();
    activities.forEach(a => a.distance = a.distance * 0.000621371);
    
    const today = new Date();
    const daysData = {};
    
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      const requiredDistance = getRequiredDistance(date);
      const runsForDay = getRunsForDate(activities, date);
      const goalCheck = checkDailyGoal(runsForDay, requiredDistance);
      
      let status;
      const isFuture = date > today;
      const isToday = date.toDateString() === today.toDateString();
      
      if (isFuture) {
        status = 'pending';
      } else if (goalCheck.goalMet) {
        status = 'completed';
      } else if (isToday) {
        status = 'pending';
      } else {
        status = 'missed';
      }
      
      daysData[dateStr] = {
        date: date,
        status: status,
        requiredDistance: requiredDistance,
        totalDistance: goalCheck.totalDistance
      };
    }
    
    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${user.firstname}'s Calendar</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            max-width: 1200px; 
            margin: 50px auto; 
            padding: 20px; 
            background: #f5f5f5;
          }
          .header { 
            background: white; 
            padding: 20px; 
            border-radius: 10px; 
            margin-bottom: 20px; 
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .calendar { 
            display: grid; 
            grid-template-columns: repeat(7, 1fr); 
            gap: 10px; 
            margin: 20px 0;
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .day { 
            border: 2px solid #ddd; 
            padding: 15px; 
            border-radius: 8px; 
            text-align: center;
            min-height: 100px;
            transition: transform 0.2s;
          }
          .day:hover {
            transform: scale(1.05);
          }
          .day-header { 
            font-weight: bold; 
            font-size: 14px; 
            color: #666; 
            padding: 10px;
            text-align: center;
          }
          .day-number { 
            font-size: 24px; 
            font-weight: bold;
            margin: 10px 0; 
          }
          .day-emoji {
            font-size: 32px;
            margin: 10px 0;
          }
          .day-distance { 
            font-size: 11px; 
            color: #666;
            margin-top: 5px;
          }
          .completed { 
            background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%);
            border-color: #28a745;
          }
          .missed { 
            background: linear-gradient(135deg, #f8d7da 0%, #f5c6cb 100%);
            border-color: #dc3545;
          }
          .pending { 
            background: linear-gradient(135deg, #fff3cd 0%, #ffeeba 100%);
            border-color: #ffc107;
          }
          .bailout { 
            background: linear-gradient(135deg, #cfe2ff 0%, #b8daff 100%);
            border-color: #0066cc;
          }
          .future { 
            background: #f8f9fa;
            border-color: #dee2e6;
            opacity: 0.6;
          }
          .legend { 
            display: flex; 
            gap: 20px; 
            margin: 20px 0; 
            justify-content: center;
            flex-wrap: wrap;
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .legend-item { 
            display: flex; 
            align-items: center; 
            gap: 8px;
          }
          .legend-box { 
            width: 30px; 
            height: 30px; 
            border-radius: 5px;
            border: 2px solid;
          }
          .back-link { 
            margin-top: 30px; 
            text-align: center;
          }
          .back-link a { 
            color: #FC5200; 
            text-decoration: none; 
            font-weight: bold;
          }
          .powered-by { 
            margin-top: 40px; 
            font-size: 12px; 
            color: #666;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>📅 ${user.firstname}'s Challenge Calendar</h1>
          <p style="color: #666;">Last 30 Days</p>
        </div>
        
        <div class="legend">
          <div class="legend-item">
            <div class="legend-box completed" style="border-color: #28a745;"></div>
            <span>✅ Completed</span>
          </div>
          <div class="legend-item">
            <div class="legend-box missed" style="border-color: #dc3545;"></div>
            <span>❌ Missed</span>
          </div>
          <div class="legend-item">
            <div class="legend-box bailout" style="border-color: #0066cc;"></div>
            <span>🎫 Bailout</span>
          </div>
          <div class="legend-item">
            <div class="legend-box pending" style="border-color: #ffc107;"></div>
            <span>⏳ Today</span>
          </div>
          <div class="legend-item">
            <div class="legend-box future" style="border-color: #dee2e6;"></div>
            <span>📆 Future</span>
          </div>
        </div>
        
        <div class="calendar">
    `;
    
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayNames.forEach(day => {
      html += `<div class="day-header">${day}</div>`;
    });
    
    // Get the first day we're showing
    const firstDate = new Date(today);
    firstDate.setDate(firstDate.getDate() - 29);
    const startDayOfWeek = firstDate.getDay();
    
    // Add empty cells before first date
    for (let i = 0; i < startDayOfWeek; i++) {
      html += `<div class="day future"></div>`;
    }
    
    Object.keys(daysData).sort().forEach(dateStr => {
      const dayData = daysData[dateStr];
      const dayNum = dayData.date.getDate();
      const isToday = dayData.date.toDateString() === today.toDateString();
      const isFuture = dayData.date > today;
      
      let className = dayData.status;
      if (isFuture) className = 'future';
      if (isToday) className = 'pending';
      
      const statusEmoji = 
        dayData.status === 'completed' ? '✅' :
        dayData.status === 'missed' ? '❌' :
        dayData.status === 'bailout' ? '🎫' :
        isToday ? '⏳' : '📆';
      
      html += `
        <div class="day ${className}">
          <div class="day-number">${dayNum}</div>
          <div class="day-emoji">${statusEmoji}</div>
          <div class="day-distance">
            ${dayData.totalDistance.toFixed(1)}/${dayData.requiredDistance.toFixed(1)} mi
          </div>
        </div>
      `;
    });
    
    html += `
        </div>
        
        <div class="back-link">
          <a href="/">← Back to Dashboard</a>
        </div>
        
        <div class="powered-by">
          Powered by Strava
        </div>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Calendar error:', error);
    res.send('Error loading calendar: ' + error.message);
  }
});

// NEW: Detailed Stats Page
app.get('/stats', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  
  const user = getUserById(req.session.userId);
  
  try {
    const response = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=200', {
      headers: {
        'Authorization': `Bearer ${user.access_token}`
      }
    });
    
    const activities = await response.json();
    const runs = activities.filter(a => a.type === 'Run' || a.type === 'VirtualRun');
    
    // Calculate stats
    const totalDistance = runs.reduce((sum, r) => sum + (r.distance * 0.000621371), 0);
    const totalTime = runs.reduce((sum, r) => sum + r.moving_time, 0);
    const totalElevation = runs.reduce((sum, r) => sum + r.total_elevation_gain, 0);
    const avgDistance = totalDistance / runs.length || 0;
    const avgPace = runs.length > 0 
      ? runs.reduce((sum, r) => {
          const miles = r.distance * 0.000621371;
          return sum + (r.moving_time / 60 / miles);
        }, 0) / runs.length
      : 0;
    
    const avgPaceMin = Math.floor(avgPace);
    const avgPaceSec = Math.floor((avgPace - avgPaceMin) * 60);
    
    // Find longest run
    const longestRun = runs.reduce((max, r) => 
      r.distance > (max?.distance || 0) ? r : max, null
    );
    
    // Find fastest pace
    const fastestRun = runs.reduce((fastest, r) => {
      const pace = r.moving_time / 60 / (r.distance * 0.000621371);
      const fastestPace = fastest ? fastest.moving_time / 60 / (fastest.distance * 0.000621371) : Infinity;
      return pace < fastestPace ? r : fastest;
    }, null);
    
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const progressData = getDailyProgress(user.id, thirtyDaysAgo, today);
    const streaks = calculateStreaks(progressData);
    
    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${user.firstname}'s Detailed Stats</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            max-width: 1200px; 
            margin: 50px auto; 
            padding: 20px; 
            background: #f5f5f5;
          }
          .header { 
            background: white; 
            padding: 30px; 
            border-radius: 10px; 
            margin-bottom: 20px; 
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin: 20px 0;
          }
          .stat-card {
            background: white;
            padding: 25px;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            text-align: center;
          }
          .stat-card h3 {
            color: #666;
            font-size: 14px;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
          }
          .stat-value {
            font-size: 48px;
            font-weight: bold;
            color: #FC5200;
            margin: 10px 0;
          }
          .stat-label {
            color: #999;
            font-size: 14px;
          }
          .highlight-card {
            background: white;
            padding: 25px;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin: 20px 0;
          }
          .highlight-card h3 {
            color: #333;
            margin-bottom: 15px;
          }
          .highlight-item {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin: 10px 0;
          }
          .back-link { 
            margin-top: 30px; 
            text-align: center;
          }
          .back-link a { 
            color: #FC5200; 
            text-decoration: none; 
            font-weight: bold;
          }
          .powered-by { 
            margin-top: 40px; 
            font-size: 12px; 
            color: #666;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>📊 ${user.firstname}'s Detailed Statistics</h1>
          <p style="color: #666;">Complete running analysis</p>
        </div>
        
        <div class="stats-grid">
          <div class="stat-card">
            <h3>Total Runs</h3>
            <div class="stat-value">${runs.length}</div>
            <div class="stat-label">activities</div>
          </div>
          
          <div class="stat-card">
            <h3>Total Distance</h3>
            <div class="stat-value">${totalDistance.toFixed(1)}</div>
            <div class="stat-label">miles</div>
          </div>
          
          <div class="stat-card">
            <h3>Total Time</h3>
            <div class="stat-value">${Math.floor(totalTime / 3600)}</div>
            <div class="stat-label">hours</div>
          </div>
          
          <div class="stat-card">
            <h3>Avg Distance</h3>
            <div class="stat-value">${avgDistance.toFixed(2)}</div>
            <div class="stat-label">miles per run</div>
          </div>
          
          <div class="stat-card">
            <h3>Avg Pace</h3>
            <div class="stat-value">${avgPaceMin}:${avgPaceSec.toString().padStart(2, '0')}</div>
            <div class="stat-label">min/mile</div>
          </div>
          
          <div class="stat-card">
            <h3>Total Elevation</h3>
            <div class="stat-value">${Math.round(totalElevation * 3.28084)}</div>
            <div class="stat-label">feet climbed</div>
          </div>
          
          <div class="stat-card">
            <h3>Current Streak</h3>
            <div class="stat-value">${streaks.currentStreak}</div>
            <div class="stat-label">days</div>
          </div>
          
          <div class="stat-card">
            <h3>Longest Streak</h3>
            <div class="stat-value">${streaks.longestStreak}</div>
            <div class="stat-label">days</div>
          </div>
        </div>
        
        ${longestRun ? `
          <div class="highlight-card">
            <h3>🏆 Longest Run</h3>
            <div class="highlight-item">
              <strong>${longestRun.name}</strong><br>
              ${(longestRun.distance * 0.000621371).toFixed(2)} miles on ${new Date(longestRun.start_date).toLocaleDateString()}
            </div>
          </div>
        ` : ''}
        
        ${fastestRun ? `
          <div class="highlight-card">
            <h3>⚡ Fastest Pace</h3>
            <div class="highlight-item">
              <strong>${fastestRun.name}</strong><br>
              ${(() => {
                const pace = fastestRun.moving_time / 60 / (fastestRun.distance * 0.000621371);
                const paceMin = Math.floor(pace);
                const paceSec = Math.floor((pace - paceMin) * 60);
                return `${paceMin}:${paceSec.toString().padStart(2, '0')} min/mile`;
              })()} on ${new Date(fastestRun.start_date).toLocaleDateString()}
            </div>
          </div>
        ` : ''}
        
        <div class="back-link">
          <a href="/">← Back to Dashboard</a>
        </div>
        
        <div class="powered-by">
          Powered by Strava
        </div>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Stats error:', error);
    res.send('Error loading stats: ' + error.message);
  }
});

// Enhanced Leaderboard with Winner Determination
app.get('/leaderboard', async (req, res) => {
  const users = getAllUsers();
  
  try {
    // Fetch progress data for all users
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const progressDataMap = {};
    for (const user of users) {
      progressDataMap[user.id] = getDailyProgress(user.id, thirtyDaysAgo, today);
    }
    
    // Determine winner
    const winner = determineWinner(users, progressDataMap);
    
    // Calculate stats for each user
    const userStats = users.map(user => {
      const progressData = progressDataMap[user.id] || [];
      const streaks = calculateStreaks(progressData);
      const totalDaysRun = getTotalDaysRun(progressData);
      const consecutiveMisses = getConsecutiveMisses(user.id, today);
      const streakStatus = validateStreak(user.id, consecutiveMisses);
      
      return {
        ...user,
        totalDaysRun,
        currentStreak: streaks.currentStreak,
        longestStreak: streaks.longestStreak,
        consecutiveMisses,
        streakStatus: streakStatus.status
      };
    });
    
    // Sort by: active first, then total days run
    userStats.sort((a, b) => {
      if (a.elimination_date && !b.elimination_date) return 1;
      if (!a.elimination_date && b.elimination_date) return -1;
      return b.totalDaysRun - a.totalDaysRun;
    });
    
    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Running Challenge Leaderboard</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            max-width: 1200px; 
            margin: 50px auto; 
            padding: 20px; 
            background: #f5f5f5;
          }
          .header { 
            background: white; 
            padding: 30px; 
            border-radius: 10px; 
            margin-bottom: 20px; 
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            text-align: center;
          }
          .winner-banner {
            background: linear-gradient(135deg, #ffd700 0%, #ffed4e 100%);
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 20px;
            text-align: center;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            border: 3px solid #ffc107;
          }
          .winner-banner h2 {
            font-size: 32px;
            margin-bottom: 10px;
          }
          table { 
            width: 100%; 
            border-collapse: collapse; 
            margin: 20px 0; 
            background: white; 
            border-radius: 10px; 
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          th, td { 
            padding: 15px; 
            text-align: left; 
            border-bottom: 1px solid #ddd; 
          }
          th { 
            background: #f5f5f5; 
            font-weight: bold; 
          }
          .eliminated { 
            background-color: #f8d7da; 
            opacity: 0.7;
          }
          .at-risk { 
            background-color: #fff3cd; 
          }
          .rank-1 {
            background: linear-gradient(135deg, #ffd700 0%, #ffed4e 50%);
            font-weight: bold;
          }
          .rank-2 {
            background: linear-gradient(135deg, #c0c0c0 0%, #e8e8e8 50%);
          }
          .rank-3 {
            background: linear-gradient(135deg, #cd7f32 0%, #e8a87c 50%);
          }
          .back-link { 
            margin-top: 30px; 
            text-align: center;
          }
          .back-link a { 
            color: #FC5200; 
            text-decoration: none; 
            font-weight: bold;
          }
          .powered-by { 
            margin-top: 40px; 
            font-size: 12px; 
            color: #666;
            text-align: center;
          }
          .stats-summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin: 20px 0;
          }
          .stats-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .stats-number {
            font-size: 36px;
            font-weight: bold;
            color: #FC5200;
          }
          .stats-label {
            color: #666;
            font-size: 14px;
            margin-top: 5px;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>🏆 Zhou Family Running Challenge</h1>
          <p style="color: #666;">Leaderboard & Standings</p>
        </div>
    `;
    
    if (winner) {
      html += `
        <div class="winner-banner">
          <h2>👑 Current Leader</h2>
          <h1 style="margin: 10px 0; font-size: 48px;">${winner.firstname} ${winner.lastname}</h1>
          ${winner.elimination_date 
            ? `<p>Last to be eliminated (${new Date(winner.elimination_date).toLocaleDateString()})</p>`
            : '<p>🔥 Still in the game!</p>'
          }
        </div>
      `;
    }
    
    const totalParticipants = users.length;
    const activeCount = users.filter(u => !u.elimination_date).length;
    const eliminatedCount = totalParticipants - activeCount;
    const totalDaysCompleted = userStats.reduce((sum, u) => sum + u.totalDaysRun, 0);
    
    html += `
      <div class="stats-summary">
        <div class="stats-card">
          <div class="stats-number">${totalParticipants}</div>
          <div class="stats-label">Total Participants</div>
        </div>
        <div class="stats-card">
          <div class="stats-number">${activeCount}</div>
          <div class="stats-label">Still Active</div>
        </div>
        <div class="stats-card">
          <div class="stats-number">${eliminatedCount}</div>
          <div class="stats-label">Eliminated</div>
        </div>
        <div class="stats-card">
          <div class="stats-number">${totalDaysCompleted}</div>
          <div class="stats-label">Total Days Run</div>
        </div>
      </div>
    `;
    
    if (userStats.length === 0) {
      html += '<p>No participants yet. Be the first to join!</p>';
    } else {
      html += '<table>';
      html += `
        <tr>
          <th>Rank</th>
          <th>Name</th>
          <th>Status</th>
          <th>Days Run</th>
          <th>Current Streak</th>
          <th>Longest Streak</th>
          <th>Bailout Passes</th>
          <th>Consecutive Misses</th>
        </tr>
      `;
      
      userStats.forEach((user, index) => {
        let status = '✅ Active';
        let rowClass = '';
        
        if (user.elimination_date) {
          status = `❌ Eliminated (${new Date(user.elimination_date).toLocaleDateString()})`;
          rowClass = 'eliminated';
        } else if (user.streakStatus === 'at_risk') {
          status = '⚠️ At Risk';
          rowClass = 'at-risk';
        }
        
        // Add medal styling for top 3
        if (!user.elimination_date) {
          if (index === 0) rowClass += ' rank-1';
          else if (index === 1) rowClass += ' rank-2';
          else if (index === 2) rowClass += ' rank-3';
        }
        
        const rankDisplay = index + 1;
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
        
        html += `
          <tr class="${rowClass}">
            <td><strong>${rankDisplay} ${medal}</strong></td>
            <td><strong>${user.firstname} ${user.lastname}</strong></td>
            <td>${status}</td>
            <td>${user.totalDaysRun}</td>
            <td>${user.currentStreak} days</td>
            <td>${user.longestStreak} days</td>
            <td>${user.bailout_passes}/4</td>
            <td>${user.consecutiveMisses}</td>
          </tr>
        `;
      });
      
      html += '</table>';
    }
    
    html += `
        <div class="back-link">
          <a href="/">← Back to Dashboard</a>
        </div>
        
        <div class="powered-by">
          Compatible with Strava
        </div>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.send('Error loading leaderboard: ' + error.message);
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    res.redirect('/');
  });
});

app.listen(3000, () => {
  console.log('Website running at: http://localhost:3000');
  console.log('Database ready!');
  console.log('');
  console.log('📊 Dashboard Features:');
  console.log('  ✅ Today\'s progress tracking');
  console.log('  ✅ Challenge statistics');
  console.log('  ✅ Streak tracking');
  console.log('  ✅ Bailout pass management');
  console.log('  ✅ Daily progress table');
  console.log('  ✅ Visual calendar');
  console.log('  ✅ Detailed stats');
  console.log('  ✅ Winner determination');
  console.log('  ✅ Enhanced leaderboard');
  console.log('');
});
