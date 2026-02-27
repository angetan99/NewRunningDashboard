import Database from 'better-sqlite3';

// Create/open database file
const db = new Database('challenge.db');

// Create users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strava_id TEXT UNIQUE NOT NULL,
    firstname TEXT NOT NULL,
    lastname TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    token_expires_at INTEGER NOT NULL,
    bailout_passes INTEGER DEFAULT 4,
    elimination_date TEXT,
    elimination_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Create activities table
db.exec(`
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    strava_activity_id TEXT UNIQUE NOT NULL,
    name TEXT,
    distance REAL NOT NULL,
    moving_time INTEGER NOT NULL,
    elapsed_time INTEGER NOT NULL,
    type TEXT NOT NULL,
    start_date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Create daily_progress table
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    required_distance REAL NOT NULL,
    completed_distance REAL NOT NULL,
    status TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// ============================================
// USER MANAGEMENT FUNCTIONS
// ============================================

// Save or update a user
export function saveUser(stravaData) {
  const stmt = db.prepare(`
    INSERT INTO users (strava_id, firstname, lastname, access_token, refresh_token, token_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(strava_id) 
    DO UPDATE SET 
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expires_at = excluded.token_expires_at
  `);

  const result = stmt.run(
    stravaData.athlete.id.toString(),
    stravaData.athlete.firstname,
    stravaData.athlete.lastname,
    stravaData.access_token,
    stravaData.refresh_token,
    stravaData.expires_at
  );

  return result.lastInsertRowid || getUserByStravaId(stravaData.athlete.id.toString()).id;
}

// Get user by Strava ID
export function getUserByStravaId(stravaId) {
  const stmt = db.prepare('SELECT * FROM users WHERE strava_id = ?');
  return stmt.get(stravaId.toString());
}

// Get user by database ID
export function getUserById(id) {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(id);
}

// Get all users (for leaderboard)
export function getAllUsers() {
  const stmt = db.prepare('SELECT * FROM users ORDER BY created_at');
  return stmt.all();
}

// Use a bailout pass
export function useBailoutPass(userId) {
  const stmt = db.prepare(`
    UPDATE users 
    SET bailout_passes = bailout_passes - 1 
    WHERE id = ? AND bailout_passes > 0
  `);
  return stmt.run(userId);
}

// Get bailout passes remaining
export function getBailoutPasses(userId) {
  const stmt = db.prepare('SELECT bailout_passes FROM users WHERE id = ?');
  const result = stmt.get(userId);
  return result ? result.bailout_passes : 0;
}

// Update elimination status
export function eliminateUser(userId, eliminationDate, reason) {
  const stmt = db.prepare(`
    UPDATE users 
    SET elimination_date = ?, elimination_reason = ?
    WHERE id = ?
  `);
  
  return stmt.run(eliminationDate, reason, userId);
}

// ============================================
// DAILY PROGRESS FUNCTIONS
// ============================================

// Save daily progress
export function saveDailyProgress(userId, date, requiredDistance, completedDistance, status) {
  const dateStr = date.toISOString().split('T')[0];
  
  const stmt = db.prepare(`
    INSERT INTO daily_progress (user_id, date, required_distance, completed_distance, status)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) 
    DO UPDATE SET 
      completed_distance = excluded.completed_distance,
      status = excluded.status
  `);
  
  return stmt.run(userId, dateStr, requiredDistance, completedDistance, status);
}

// Get daily progress for a user
export function getDailyProgress(userId, startDate, endDate) {
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];
  
  const stmt = db.prepare(`
    SELECT * FROM daily_progress 
    WHERE user_id = ? AND date >= ? AND date <= ?
    ORDER BY date DESC
  `);
  
  return stmt.all(userId, startStr, endStr);
}

// Get consecutive misses
export function getConsecutiveMisses(userId, endDate) {
  const endStr = endDate.toISOString().split('T')[0];
  
  const stmt = db.prepare(`
    SELECT * FROM daily_progress 
    WHERE user_id = ? AND date <= ?
    ORDER BY date DESC
    LIMIT 10
  `);
  
  const recentDays = stmt.all(userId, endStr);
  
  let consecutiveMisses = 0;
  for (const day of recentDays) {
    if (day.status === 'missed') {
      consecutiveMisses++;
    } else if (day.status === 'completed' || day.status === 'bailout') {
      break;
    }
  }
  
  return consecutiveMisses;
}

// ============================================
// ACTIVITY FUNCTIONS (for future use)
// ============================================

// Save activity
export function saveActivity(userId, activityData) {
  const stmt = db.prepare(`
    INSERT INTO activities 
    (user_id, strava_activity_id, name, distance, moving_time, elapsed_time, type, start_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strava_activity_id) DO UPDATE SET
      distance = excluded.distance,
      moving_time = excluded.moving_time,
      elapsed_time = excluded.elapsed_time
  `);
  
  return stmt.run(
    userId,
    activityData.id.toString(),
    activityData.name,
    activityData.distance * 0.000621371, // Convert meters to miles
    activityData.moving_time,
    activityData.elapsed_time,
    activityData.type,
    activityData.start_date
  );
}

// Get activities for a user
export function getActivitiesByUser(userId, limit = 30) {
  const stmt = db.prepare(`
    SELECT * FROM activities 
    WHERE user_id = ?
    ORDER BY start_date DESC
    LIMIT ?
  `);
  
  return stmt.all(userId, limit);
}
export default db;
