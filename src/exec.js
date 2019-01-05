let {exec} = require('child-process');
exec('node app.js', function(err, stdout, err) {
    console.log(stdout);
})