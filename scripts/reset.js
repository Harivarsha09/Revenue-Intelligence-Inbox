require('fs').rmSync(require('path').join(__dirname, '..', 'state', 'state.json'), { force: true }); console.log('state cleared: app will start empty');
