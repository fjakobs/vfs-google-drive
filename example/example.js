var rl = require('readline');

var i = rl.createInterface(process.stdin, process.stdout, null);

// Create a new instance.  Hard-code the access token for now
var vfs = require('vfs-google-drive')({
    getAccessToken: function (callback) {
    	console.log(
    		"To generate token, go to https://code.google.com/oauthplayground/ " + 
    		"and request permission for the https://www.googleapis.com/auth/drive OAuth scope."
    	);
        i.question("Please enter access token: ", function (token) {
            callback(null, token);
        });
    }
});


require('http').createServer(require('stack')(
    require('vfs-http-adapter')("/", vfs)
)).listen(8080, function () {
    console.log("Google Drive http://localhost:8080/");
});
