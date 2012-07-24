
var https = require('https');
var dirname = require('path').dirname;
var basename = require('path').basename;
var urlParse = require('url').parse;
var getMime = require('simple-mime')("application/octet-stream");
var Stream = require('stream').Stream;

function once(fn) {
    var done = false;
    return function () {
        if (done) {
            console.warn("Attempt to call callback more than once " + fn);
            return;
        }
        done = true;
        return fn.apply(this, arguments);
    };
}

// fsOptions.getAccessToken - function to get oAuth token getAuth(callback(err, auth))
// fsOptions.cacheLifetime - time to consider cached File metatada valid. Defaults to 60000ms
module.exports = function setup(fsOptions) {

    // Cache the oauth2 token
    var auth;
    // Cache path->ID mappings
    var paths;
    // Cache file data
    var files;

    // TODO: use GET https://www.googleapis.com/drive/v2/changes to know when to invalidate changes
    var fileCacheLifetime = fsOptions.hasOwnProperty("cacheLifetime") ? fsOptions.cacheLifetime : 60000;

    resetCache();

    return {
        readfile: readfile,
        mkfile: mkfile,
        rmfile: rmfile,
        readdir: readdir,
        stat: stat,
        mkdir: mkdir,
        rmdir: rmdir,
        rename: rename,
        copy: copy,
        symlink: symlink,
        resetCache: resetCache
    };

    function resetCache() {
        auth = undefined;
        paths = { "/": "root" }; // special case for root node.
        files = {};
    }

    function generateRequestOptions(method, url, callback) {
        console.log("%s %s", method, url);
        var options = urlParse(url);
        options.method = method;
        if (auth) return done();
        fsOptions.getAccessToken(function (err, token) {
            if (err) return callback(err);
            auth = "OAuth " + token;
            done();
        });
        function done() {
            options.headers = { Authorization: auth };
            callback(null, options);
        }
    }

    // Make an API request
    function request(method, url, body, callback) {
        callback = once(callback); // Ensure the callback is only called once.

        generateRequestOptions(method, url, function (err, options) {
            if (body) {
                var headers = options.headers;
                body = JSON.stringify(body);
                headers["Content-Type"] = "application/json",
                headers["Content-Length"] = Buffer.byteLength(body);
            }
            var json = JSON.stringify(body);
            var req = https.request(options, onResponse);
            req.on("error", callback);
            if (body) req.end(body);
            else req.end();
        });

        function onResponse(res) {
            if (res.statusCode !== 200) {
                if (res.statusCode === 401) {
                    auth = undefined;
                    // TODO: tell client our token is bad
                }
                // console.log(res);
                return callback(new Error("Failed API request " + res.statusCode));
            }
            var data = "";
            res.setEncoding("utf8");
            res.on("data", function (chunk) {
                data += chunk;
            });
            res.on("end", function () {
                var response = JSON.parse(data);
                callback(null, response);
            });
        }
    }

    // Get a file from an id.
    function getFile(id, callback) {
        if (files.hasOwnProperty(id)) {
            var file = files[id];
            if (file.cachedTime + fileCacheLifetime < Date.now()) {
                delete files[id];
            }
            else {
                return callback(null, file);
            }
        }
        request("GET", "https://www.googleapis.com/drive/v2/files/" + id, null, function (err, file) {
            if (err) return callback(err);
            files[id] = file;
            file.cachedTime = Date.now();
            callback(null, file);
        });
    }

    // Given a folderID return an array of all children as Resources
    function getFiles(parentId, callback) {
        request("GET", "https://www.googleapis.com/drive/v2/files/" + parentId + "/children?q=trashed=false", null, function (err, result) {
            if (err) return callback(err);
            var left = result.items.length;
            var files = new Array(left);
            // console.log("reading %s children of %s", left, parentId);
            if (!left) {
                return callback(null, files);
            }
            result.items.forEach(function (child, i) {
                getFile(child.id, function (err, child) {
                    if (err) files[i] = err;
                    else files[i] = child;
                    if (!--left) {
                        callback(null, files);
                    }
                });
            });
        });
    }

    // Get a file ID from a path
    function getId(path, callback) {
        callback = once(callback);
        if (path.length > 1 && path[path.length - 1] === "/") path = path.substr(0, path.length - 1);
        if (paths.hasOwnProperty(path)) {
            // console.log("Cached %s -> %s", path, paths[path]);
            return callback(null, paths[path]);
        }
        var parentPath = dirname(path);
        getId(parentPath, function (err, parentId) {
            if (err) return callback(err);
            // console.log("Scanning %s", parentPath);
            getFiles(parentId, function (err, files) {
                if (err) return callback(err);
                // console.log("Got files");
                var found = false;
                files.forEach(function (file) {
                    var newPath = (parentPath === "/" ? "/" : parentPath + "/") + file.title;
                    paths[newPath] = file.id;
                    if (newPath === path) {
                        found = true;
                        // console.log("Found %s -> %s", path, file.id);
                        callback(null, file.id);
                    }
                });
                if (!found) {
                    var err = new Error("Can't find " + path);
                    err.code = "ENOENT";
                    callback(err);
                }
            });
        });
    }

    // Return a stat entry from a file id
    // This is not a node style function, the callback is just result.
    function createStatEntry(id, callback) {
        var entry = {
            id: id
        };
        getFile(id, function (err, file) {
            if (err) {
                entry.err = err;
                return callback(entry);
            }
            entry.name = file.title;
            entry.access = 4 | (file.editable ? 2 : 0);
            entry.size = file.fileSize;
            entry.mtime = (new Date(file.modifiedDate)).valueOf();
            entry.mime = file.mimeType;
            entry.labels = file.labels;
            if (entry.mime === "application/octet-stream") {
                entry.mime = getMime(file.title);  
            }
            callback(entry);
        });
    }

    function readfile(path, options, callback) {
        callback = once(callback);
        getId(path, function (err, id) {
            if (err) return callback(err);
            getFile(id, function (err, file) {
                if (err) return callback(err);
                if (file.mimeType === "application/vnd.google-apps.folder") {
                    return callback(new Error(path + " is a folder"));
                }
                if (!file.downloadUrl) {
                    return callback(new Error(path + " is not downloadable"));
                }

                generateRequestOptions("GET", file.downloadUrl, function (err, reqOptions) {
                    if (err) return callback(err);

                    var meta = {
                        mime: file.mimeType,
                        size: file.fileSize,
                        etag: file.etag,
                    };
                    if (meta.mime === "application/octet-stream") {
                        meta.mime = getMime(path);
                    }

                    // ETag support
                    if (options.etag === meta.etag) {
                        meta.notModified = true;
                        return callback(null, meta);
                    }


                    // Range support
                    if (options.hasOwnProperty('range') && !(options.range.etag && options.range.etag !== meta.etag)) {
                        var range = options.range;
                        var start, end;
                        if (range.hasOwnProperty("start")) {
                            start = range.start;
                            end = range.hasOwnProperty("end") ? range.end : meta.size - 1;
                        }
                        else {
                            if (range.hasOwnProperty("end")) {
                                start = meta.size - range.end;
                                end = meta.size - 1;
                            }
                            else {
                                meta.rangeNotSatisfiable = "Invalid Range";
                                return callback(null, meta);
                            }
                        }
                        if (end < start || start < 0 || end >= meta.size) {
                            meta.rangeNotSatisfiable = "Range out of bounds";
                            return callback(null, meta);
                        }
                        reqOptions.headers.Range = 'bytes=' + start + '-' + end;
                        meta.partialContent = { start: start, end: end, size: meta.size };
                        meta.size = end - start + 1;
                    }

                    // HEAD support
                    if (options.head) {
                        return callback(null, meta);
                    }

                    var req = https.request(reqOptions, function (res) {
                        if (res.statusCode >= 400) {
                            return callback(new Error("Problem downloading content"));
                        }
                        meta.stream = res;
                        callback(null, meta);
                    });
                    req.on("error", callback);
                    req.end();
                });
            });
        });
    }

    function mkfile(path, options, callback) {
        if (!options.stream) {
            return callback(new Error("stream is an required option"));
        }

        // Pause the input for now since we're not ready to write quite yet
        var readable = options.stream;
        if (readable.pause) readable.pause();
        var buffer = [];
        readable.on("data", onData);
        readable.on("end", onEnd);
        function onData(chunk) {
          buffer.push(["data", chunk]);
        }
        function onEnd() {
          buffer.push(["end"]);
        }
        function error(err) {
          readable.removeListener("data", onData);
          readable.removeListener("end", onEnd);
          if (readable.destroy) readable.destroy();
          if (err) callback(err);
        }


        // First check to see if the file already exists at that path
        getId(path, function (err, id) {
            if (err) {
                if (err.code === "ENOENT") return create();
                else return error(err);
            }
            // Upload over the existing file.
            return upload(id);

            function create() {
                // Get the parent's id so we can insert a new file inside it.
                getId(dirname(path), function (err, parentId) {
                    if (err) return error(err);
                    var req = {
                        title: basename(path),
                        parents: [{id: parentId}]
                    };
                    request("POST", "https://www.googleapis.com/drive/v2/files", req, function (err, file) {
                        if (err) return error(err);
                        // Store this new information in the lookup cache
                        files[file.id] = file;
                        paths[path] = file.id;
                        upload(file.id);
                    });
                });
            }
            function upload(id) {
                generateRequestOptions("PUT", "https://www.googleapis.com/upload/drive/v2/files/" + id + "?uploadType=media", function (err, reqOptions) {
                    if (err) return error(err);

                    var stream = https.request(reqOptions, function (res) {
                        if (res.statusCode === 200) {
                            // Invalidate the file cache now that the file is changed.
                            delete files[id];
                            callback(null, {id: id});
                        }
                        else {
                            res.on("data", console.error);
                            error(new Error("Problem uploading file"));
                        }
                    });

                    readable.pipe(stream);

                    // Stop buffering events and playback anything that happened.
                    readable.removeListener("data", onData);
                    readable.removeListener("end", onEnd);
                    buffer.forEach(function (event) {
                        readable.emit.apply(readable, event);
                    });
                    // Resume the input stream if possible
                    if (readable.resume) readable.resume();
                });
            }
        });
    }
    function rmfile(path, options, callback) {
        callback(new Error("rmfile: Not Implemented"));
    }

    function readdir(path, options, callback) {
        var meta = {};
        getId(path, function (err, id) {
            if (err) return callback(err);
            request("GET", "https://www.googleapis.com/drive/v2/files/" + id + "/children?q=trashed=false", null, function (err, result) {

                if (err) return callback(err);
                meta.etag = result.etag;
                if (options.etag === meta.etag) {
                  meta.notModified = true;
                  return callback(null, meta);
                }
                if (options.head) {
                    return callback(null, meta);
                }

                var stream = new Stream();
                stream.readable = true;
                var paused;
                stream.pause = function () {
                    if (paused === true) return;
                    paused = true;
                };
                stream.resume = function () {
                    if (paused === false) return;
                    paused = false;
                    getNext();
                };

                var children = result.items;

                meta.stream = stream;
                callback(null, meta);
                var index = 0;
                stream.resume();


                function getNext() {
                    if (index === children.length) return done();
                    var child = children[index++];
                    var left = children.length - index;

                    createStatEntry(child.id, function (entry) {
                        stream.emit("data", entry);
                        if (!paused) getNext();
                    });
                }

                function done() {
                    stream.emit("end");
                }
            });
        });
    }

    function stat(path, options, callback) {
        callback(new Error("stat: Not Implemented"));
    }

    function mkdir(path, options, callback) {
        if (path[path.length - 1] === "/") path = path.substr(0, path.length - 1);

        // First check to see if the folder already exists at that path
        getId(path, function (err, id) {
            if (err) {
                if (err.code === "ENOENT") return create();
                else return callback(err);
            }
            return callback(new Error("File already exists at that path"));

            function create() {
                // Get the parent's id so we can insert a new file inside it.
                getId(dirname(path), function (err, parentId) {
                    if (err) return callback(err);
                    var req = {
                        title: basename(path),
                        mimeType: "application/vnd.google-apps.folder",
                        parents: [{id: parentId}]
                    };
                    request("POST", "https://www.googleapis.com/drive/v2/files", req, function (err, file) {
                        if (err) return callback(err);
                        files[file.id] = file;
                        paths[path] = file.id;
                        callback(null, {});
                    });
                });
            }
        });
    }

    function rmdir(path, options, callback) {
        callback(new Error("rmdir: Not Implemented"));
    }
    function rename(path, options, callback) {
        callback(new Error("rename: Not Implemented"));
    }
    function copy(path, options, callback) {
        callback(new Error("copy: Not Implemented"));
    }
    function symlink(path, options, callback) {
        callback(new Error("symlink: Not Implemented"));
    }
};

