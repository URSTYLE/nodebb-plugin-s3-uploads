var Package = require("./package.json");

var AWS = require("aws-sdk"),
	mime = require("mime"),
	uuid = require("uuid").v4,
	fs = require("fs"),
	request = require("request"),
	path = require("path"),
	winston = module.parent.require("winston"),
	nconf = module.parent.require('nconf'),
	gm = require("gm"),
	im = gm.subClass({imageMagick: true}),
	meta = module.parent.require("./meta"),
	db = module.parent.require("./database");

var plugin = {}

"use strict";

var S3Conn = null;
var settings = {
	"accessKeyId": false,
	"secretAccessKey": false,
	"region": "us-west-004",
	"bucket": process.env.S3_UPLOADS_BUCKET || undefined,
	"host": process.env.S3_UPLOADS_HOST || "f004.backblazeb2.com/file",
	"path": process.env.S3_UPLOADS_PATH || undefined
};

var accessKeyIdFromDb = false;
var secretAccessKeyFromDb = false;

function fetchSettings(callback) {
	db.getObjectFields(Package.name, Object.keys(settings), function (err, newSettings) {
		if (err) {
			winston.error(err.message);
			if (typeof callback === "function") {
				callback(err);
			}
			return;
		}

		accessKeyIdFromDb = false;
		secretAccessKeyFromDb = false;

		if (newSettings.accessKeyId) {
			settings.accessKeyId = newSettings.accessKeyId;
			accessKeyIdFromDb = true;
		} else {
			settings.accessKeyId = false;
		}

		if (newSettings.secretAccessKey) {
			settings.secretAccessKey = newSettings.secretAccessKey;
			secretAccessKeyFromDb = false;
		} else {
			settings.secretAccessKey = false;
		}

		if (!newSettings.bucket) {
			settings.bucket = process.env.S3_UPLOADS_BUCKET || "";
		} else {
			settings.bucket = newSettings.bucket;
		}

		if (!newSettings.host) {
			settings.host = process.env.S3_UPLOADS_HOST || "";
		} else {
			settings.host = newSettings.host;
		}

		if (!newSettings.path) {
			settings.path = process.env.S3_UPLOADS_PATH || "";
		} else {
			settings.path = newSettings.path;
		}

		if (!newSettings.region) {
			settings.region = process.env.AWS_DEFAULT_REGION || "";
		} else {
			settings.region = newSettings.region;
		}

		if (settings.accessKeyId && settings.secretAccessKey) {
			AWS.config.update({
				accessKeyId: settings.accessKeyId,
				secretAccessKey: settings.secretAccessKey
			});
		}

		if (settings.region) {
			AWS.config.update({
				region: settings.region
			});
		}

		if (typeof callback === "function") {
			callback();
		}
	});
}

function S3() {
	if (!S3Conn) {
		var ep = new AWS.Endpoint('s3.us-west-004.backblazeb2.com');
		S3Conn = new AWS.S3({endpoint: ep});
	}

	return S3Conn;
}

function makeError(err) {
	if (err instanceof Error) {
		err.message = Package.name + " :: " + err.message;
	} else {
		err = new Error(Package.name + " :: " + err);
	}

	winston.error(err.message);
	return err;
}

plugin.activate = function (data) {
	if (data.id === 'nodebb-plugin-s3-uploads') {
		fetchSettings();
	}

};

plugin.deactivate = function (data) {
	if (data.id === 'nodebb-plugin-s3-uploads') {
		S3Conn = null;
	}
};

plugin.load = function (params, callback) {
	fetchSettings(function (err) {
		if (err) {
			return winston.error(err.message);
		}
		var adminRoute = "/admin/plugins/s3-uploads";

		params.router.get(adminRoute, params.middleware.applyCSRF, params.middleware.admin.buildHeader, renderAdmin);
		params.router.get("/api" + adminRoute, params.middleware.applyCSRF, renderAdmin);

		params.router.post("/api" + adminRoute + "/s3settings", s3settings);
		params.router.post("/api" + adminRoute + "/credentials", credentials);

		callback();
	});
};

function renderAdmin(req, res) {
	// Regenerate csrf token
	var token = req.csrfToken();

	var forumPath = nconf.get('url');
	if(forumPath.split("").reverse()[0] != "/" ){
		forumPath = forumPath + "/";
	}
	var data = {
		bucket: settings.bucket,
		host: settings.host,
		path: settings.path,
		forumPath: forumPath,
		region: settings.region,
		accessKeyId: (accessKeyIdFromDb && settings.accessKeyId) || "",
		secretAccessKey: (accessKeyIdFromDb && settings.secretAccessKey) || "",
		csrf: token
	};

	res.render("admin/plugins/s3-uploads", data);
}

function s3settings(req, res, next) {
	var data = req.body;
	var newSettings = {
		bucket: data.bucket || "",
		host: data.host || "",
		path: data.path || "",
		region: data.region || ""
	};

	saveSettings(newSettings, res, next);
}

function credentials(req, res, next) {
	var data = req.body;
	var newSettings = {
		accessKeyId: data.accessKeyId || "",
		secretAccessKey: data.secretAccessKey || ""
	};

	saveSettings(newSettings, res, next);
}

function saveSettings(settings, res, next) {
	db.setObject(Package.name, settings, function (err) {
		if (err) {
			return next(makeError(err));
		}

		fetchSettings();
		res.json("Saved!");
	});
}

plugin.uploadImage = function (data, callback) {
	var image = data.image;

	if (!image) {
		winston.error("invalid image" );
		return callback(new Error("invalid image"));
	}

	//check filesize vs. settings
	if (image.size > parseInt(meta.config.maximumFileSize, 10) * 1024) {
		winston.error("error:file-too-big, " + meta.config.maximumFileSize );
		return callback(new Error("[[error:file-too-big, " + meta.config.maximumFileSize + "]]"));
	}

	var type = image.url ? "url" : "file";
	var allowedMimeTypes = ['image/png', 'image/jpeg', 'image/gif'];

	if (type === "file") {
		if (!image.path) {
			return callback(new Error("invalid image path"));
		}

		if (allowedMimeTypes.indexOf(mime.getType(image.path)) === -1) {
			return callback(new Error("invalid mime type"));
		}

		fs.readFile(image.path, function (err, buffer) {
			uploadToS3(image.name, err, buffer, callback);
		});
	}
	else {
		if (allowedMimeTypes.indexOf(mime.getType(image.url)) === -1) {
			return callback(new Error("invalid mime type"));
		}
		var filename = image.url.split("/").pop();

		var imageDimension = parseInt(meta.config.profileImageDimension, 10) || 128;

		// Resize image.
		im(request(image.url), filename)
			.resize(imageDimension + "^", imageDimension + "^")
			.stream(function (err, stdout, stderr) {
				if (err) {
					return callback(makeError(err));
				}

				// This is sort of a hack - We"re going to stream the gm output to a buffer and then upload.
				// See https://github.com/aws/aws-sdk-js/issues/94
				var buf = new Buffer(0);
				stdout.on("data", function (d) {
					buf = Buffer.concat([buf, d]);
				});
				stdout.on("end", function () {
					uploadToS3(filename, null, buf, callback);
				});
			});
	}
};

plugin.uploadFile = function (data, callback) {
	var file = data.file;

	if (!file) {
		return callback(new Error("invalid file"));
	}

	if (!file.path) {
		return callback(new Error("invalid file path"));
	}

	//check filesize vs. settings
	if (file.size > parseInt(meta.config.maximumFileSize, 10) * 1024) {
		winston.error("error:file-too-big, " + meta.config.maximumFileSize );
		return callback(new Error("[[error:file-too-big, " + meta.config.maximumFileSize + "]]"));
	}

	fs.readFile(file.path, function (err, buffer) {
		uploadToS3(file.name, err, buffer, callback);
	});
};

function uploadToS3(filename, err, buffer, callback) {
  if (err) {
      return callback(makeError(err));
  }

  var upload = function (formatBuffer, formatExtension) {
      var s3KeyPath = getS3KeyPath(filename, formatExtension);

      var params = {
          Bucket: settings.bucket,
          ACL: "public-read",
          Key: s3KeyPath,
          Body: formatBuffer,
          ContentLength: formatBuffer.length,
          ContentType: mime.lookup(s3KeyPath)
      };

      s3.putObject(params, function (err, data) {
          if (err) {
              winston.error('Error uploading to S3: ' + err);
              return callback(err);
          }

          var imageUrl = constructImageUrl(params);
          callback(null, {
              name: filename,
              url: imageUrl
          });
      });
  };

  // Convert to AVIF
  im(buffer).setFormat('avif').toBuffer(function (err, buffer) {
      if (err) {
          winston.error('Error converting to AVIF: ' + err);
          return callback(err);
      }
      upload(buffer, '.avif');
  });

  // Convert to JPEG
  im(buffer).setFormat('jpg').quality(80).toBuffer(function (err, buffer) {
      if (err) {
          winston.error('Error converting to JPEG: ' + err);
          return callback(err);
      }
      upload(buffer, '.jpg');
  });
}

function getS3KeyPath(filename, formatExtension) {
  var s3Path = settings.path || "/";
  if (!s3Path.endsWith('/')) {
      s3Path += '/';
  }
  return s3Path.replace(/^\//, '') + uuid() + path.extname(filename) + formatExtension;
}

function constructImageUrl(params) {
  var host = settings.host || `https://${params.Bucket}.s3.${settings.region}.backblazeb2.com`;
  if (!host.startsWith('http')) {
      host = 'http://' + host;
  }
  return host + '/' + params.Key;
}


var admin = plugin.admin = {};

admin.menu = function (custom_header, callback) {
	custom_header.plugins.push({
		"route": "/plugins/s3-uploads",
		"icon": "fa-envelope-o",
		"name": "S3 Uploads"
	});

	callback(null, custom_header);
};

module.exports = plugin;
