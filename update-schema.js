import Database from 'better-sqlite3';

const db = new Database('challenge.db');

console.log('📊 Adding age grading fields to database...\n');

// Add age grading fields to users table
const fieldsToAdd = [
  { name: 'age', type: 'INTEGER' },
  { name: 'sex', type: 'TEXT' },
  { name: 'baseline_mile_pace', type: 'REAL' }, // in minutes (e.g., 8.5 = 8:30/mile)
  { name: 'profile_complete', type: 'INTEGER DEFAULT 0' }
];

fieldsToAdd.forEach(field => {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${field.name} ${field.type}`);
    console.log(`✅ Added ${field.name} column`);
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log(`⚠️  ${field.name} column already exists`);
    } else {
      console.log(`❌ Error adding ${field.name}:`, e.message);
    }
  }
});

// Update existing users with dummy data
console.log('\n🎭 Adding dummy age grading data to existing users...\n');

const users = db.prepare('SELECT * FROM users').all();

if (users.length > 0) {
  const dummyProfiles = [
    { age: 18, sex: 'M', pace: 7.5 },  // 7:30/mile - young male
    { age: 25, sex: 'F', pace: 9.0 },  // 9:00/mile - young female
    { age: 35, sex: 'M', pace: 8.0 },  // 8:00/mile - middle age male
    { age: 45, sex: 'F', pace: 9.5 },  // 9:30/mile - middle age female
    { age: 55, sex: 'M', pace: 8.5 },  // 8:30/mile - older male
  ];
  
  const updateUser = db.prepare(`
    UPDATE users 
    SET age = ?, sex = ?, baseline_mile_pace = ?, profile_complete = 1
    WHERE id = ?
  `);
  
  users.forEach((user, index) => {
    const profile = dummyProfiles[index % dummyProfiles.length];
    updateUser.run(profile.age, profile.sex, profile.pace, user.id);
    console.log(`✅ Updated ${user.firstname} ${user.lastname}: Age ${profile.age}, ${profile.sex}, ${profile.pace} min/mile baseline`);
  });
} else {
  console.log('No users found to update.');
}

console.log('\n✅ Schema updated successfully!');

db.close();
