// Make a backup now, from the command line:  npm run backup
const { createBackup } = await import('../backup.js');
console.log(createBackup('manual'));
