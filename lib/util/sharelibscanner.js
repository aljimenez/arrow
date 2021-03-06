/*jslint forin:true sub:true anon:true, sloppy:true, stupid:true nomen:true, node:true continue:true*/

/*
 * Copyright (c) 2013, Yahoo! Inc.  All rights reserved.
 *
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

var path = require('path'),
    fs = require('fs'),
    libvm = require('vm'),
    crypto = require('crypto'),
    FileUtil = require('./fileutil');

var sync = require('async');
var log4js = require("log4js");
var shareLibLogger = new log4js.getLogger("sharelibScanner");

var servermgr = require('../../arrow_server/arrowservermanager');

var SHARE_LIB_CONTROLLER_DIR = "controller";
var SHARE_LIB_YUILIB_DIR = "lib";
var SHARE_LIB_MODULES_DIR = ["server", "client", "common"];

var CUSTOM_CONTROLLER_META = "custom_controller.json";
var CLIENT_CONFIG_NAME = "client_config.json";
var SERVER_CONFIG_NAME = "server_config.json";

var ARROW_SERVER_IPADDR_TEMPLATE = "ARROW_SERVER_IPADDR";
var arrowConfig = require('../../config/config');

var ARROW_MODULES_ROOT = arrowConfig.arrowModuleRoot || path.join(__dirname, "../");
var SHARE_LIB_DIR_PREFIX = arrowConfig.scanShareLibPrefix || [];
var SHARE_LIB_SCAN_RECURSIVE = arrowConfig.scanShareLibRecursive || false;
var BUILD_IN_SHARE_LIB_PATH = path.join(ARROW_MODULES_ROOT, "sharelib");

var USERHOME = process.platform === 'win32' ?
    process.env.USERPROFILE : process.env.HOME;

var scanlibpath = arrowConfig.shareLibPath || [];
var arrowServerHost;

var config_client;
var config_server;
var custom_controller;

/**
 * get share lib meta path
 * save to /Users/***\/.Arrow/__arrow_hash__/
 */
var shareLibMetaPath = (function () {
    // first try arrow/tmp
    var metapath = path.join(ARROW_MODULES_ROOT, "tmp");
    try {
        fs.writeFileSync(path.join(metapath, "README.md"), "For write aceess check!", "utf8");
    } catch (err) {
        if (err.code === 'EACCES') {
            // no write acess,then make it to HOME/.Arrow/__path_hash__
            metapath = path.join(USERHOME, ".Arrow", calcLibHashByFsPath(ARROW_MODULES_ROOT));
            new FileUtil().createDirectory(metapath);
        }
    }
    return metapath;
})();

// some sanner util for get/set scanned config meta
var scannerUtil = {};
/**
 * get share lib client meta fs path
 * save to /Users/***\/_arrow_hash_/client_config.json
 */
scannerUtil.getShareLibMetaPath = function () {
    return path.normalize(shareLibMetaPath);
}
/**
 * get share lib client meta fs path
 * save to /Users/***\/_arrow_hash_/client_config.json
 */
scannerUtil.getShareLibClientSideMetaPath = function () {
    return path.join(shareLibMetaPath, CLIENT_CONFIG_NAME);
}
/**
 * get share lib server side meta path
 * save to /Users/***\/_arrow_hash_/server_config.json
 */
scannerUtil.getShareLibServerSideMetaPath = function () {
    return path.join(shareLibMetaPath, SERVER_CONFIG_NAME);
}
/**
 * get share lib custom controller path
 * save to /Users/***\/_arrow_hash_/custom_controller.json
 */
scannerUtil.getShareLibControllerPath = function () {
    return path.join(shareLibMetaPath, CUSTOM_CONTROLLER_META);
}


/**
 * scan given path for all sharelib moudules and controllers
 * @constructor
 */
function sharelibscanner(config) {
    this.logger = shareLibLogger;
    this.config = config || {};

    if (config) {
        log4js.setGlobalLogLevel(config.logLevel);
    }

    ARROW_MODULES_ROOT = this.config['arrowModuleRoot'] || path.join(__dirname, "../");
    SHARE_LIB_DIR_PREFIX = this.config['scanShareLibPrefix'] || [];
    SHARE_LIB_SCAN_RECURSIVE = this.config['scanShareLibRecursive'] || true;
    BUILD_IN_SHARE_LIB_PATH = path.join(ARROW_MODULES_ROOT, "sharelib");
    scanlibpath = this.config['shareLibPath'] || [];

    //special condition to not show error when user is using default values
    try {
        if (config.shareLibPath.length === 1 && config.shareLibPath[0] === "./common") {
            this.defaultValue = true;
        } else {
            this.defaultValue = false;
        }
    } catch (e) {
        this.defaultValue = false;
    }

    config_client = {};
    config_server = {};
    custom_controller = {};
}

/**
 * show help
 */
//TODO : This help message is confusing , as users can keep libs in their folder too. Not sure if we should show any help here ?
function showHelp() {
    console.log("Notes :" + "\n" +
        "        It is required to organize your share lib folder like:" + "\n\n" +
        "         share_lib/\n" +
        "              |_____controller/\n" +
        "                 |_____custom-controller.js\n" +
        "              |_____lib/\n" +
        "                 |_____server/\n" +
        "                 |_____client/\n" +
        "                 |_____common/\n");
}

/**
 * calculate Hash By fs Path
 * @param path
 * @return {*}
 */
function calcLibHashByFsPath(path) {
    return crypto.createHash('md5').update(path).digest("hex");
}


/**
 * check if given file(folder) is share lib ,
 * that 's modules(folder) start with given prefix  or is just build-in lib : arrow/sharelib/
 * @param fspath file(folder) path
 * @return {Boolean}
 */
function isShareLib(fspath) {

    var i, dirName;

    if (path.normalize(fspath) === path.normalize(BUILD_IN_SHARE_LIB_PATH)) {
        return true;
    }
    if (SHARE_LIB_DIR_PREFIX.length === 0) {
        return true;  // if no prefix ,then we treat it as sharelib
    }
    dirName = path.basename(fspath);
    for (i = 0; i < SHARE_LIB_DIR_PREFIX.length; i = i + 1) {
        if (dirName.toString().indexOf(SHARE_LIB_DIR_PREFIX[i]) === 0) {
            return true;
        }
    }
    return false;
}


/**
 * check if given folder is sharelib/lib  or prefix_xxx/lib
 * @param f file(folder) name
 * @return {Boolean}
 */
function isShareLibYUILib(f) {
    return f.toString() === SHARE_LIB_YUILIB_DIR;
}

/**
 * check if given folder is Controller
 * @param f file(folder) name
 * @return {Boolean}
 */
function isShareLibController(f) {
    return f.toString() === SHARE_LIB_CONTROLLER_DIR;
}


/**
 * check if given folder is Controller
 * @param f file(folder) name
 * @return {Boolean}
 */
function isShareLibBuildInController(fspath) {
    return path.normalize(fspath) === path.join(BUILD_IN_SHARE_LIB_PATH, SHARE_LIB_CONTROLLER_DIR);
}

/**
 * check if given folder name matches these Modules Dir: ["server","client","common"]
 * @param f file(folder) name
 * @return {Boolean}
 */
function isShareLibYUIModule(f) {
    var i = SHARE_LIB_MODULES_DIR.length;
    while (i--) {
        if (SHARE_LIB_MODULES_DIR[i] === f) {
            return true;
        }
    }
    return false;
}


/**
 * check if given folder is hidden
 * @param f
 */
function isHiddenFile(f) {
    return /^\./.test(f);
}

/**
 * generate both client and server seed files by given scan folder
 * @param scanFolder
 * @param callback
 * @return {*}
 */
sharelibscanner.prototype.genSeedFile = function (scanFolder, callback) {

    var self = this;

    var tmpPath = scanFolder || scanlibpath;

    tmpPath = Array.isArray(tmpPath) ? tmpPath : [tmpPath];

    tmpPath.unshift(BUILD_IN_SHARE_LIB_PATH);

    var pathForScan = tmpPath.map(function (element) {
        return path.resolve(element);
    });

    if (!pathForScan || pathForScan.length === 0) {
        return showHelp();
    }

    function startGenerateProcess() {
        var start = new Date().getTime(),
            doScan;
        doScan = function (scanpath, finishone) {
            var fspath = path.normalize(scanpath);
            self.logger.trace('Start scan share lib from : ' + fspath);
            try {
                if (!fs.statSync(fspath).isDirectory()) {
                    if (self.defaultValue) {
                        self.logger.trace('Unable to find default share lib folder location : ' + fspath);
                    } else {
                        self.logger.error('Please make sure the share lib folder ' + fspath + ' exist!');
                        showHelp();
                    }
                    return finishone();
                }
            } catch (e) {
                if (self.defaultValue) {
                    self.logger.trace('Unable to find default share lib folder location : ' + fspath);
                } else {
                    self.logger.error('Please make sure the share lib folder ' + fspath + ' exist!');
                    showHelp();
                }
                return finishone();
            }
            // if fspath self is sharelib modules,generate meta info directly
            if (isShareLib(fspath)) {
                generateMetaData(path.basename(fspath), fspath, function (e, message) {
                    if (e) {
                        self.logger.trace(e);
                    } else {
                        self.logger.trace(message);
                    }
                    return finishone();
                });
            } else { // do scan
                scan(fspath, function (e, message) {
                    if (e) {
                        self.logger.trace(e);
                    } else {
                        self.logger.trace(message);
                    }
                    return finishone();
                });
            }
        }
        sync.forEachSeries(pathForScan, doScan, function () {
                self.logger.trace("Total time of Scan :" + (new Date().getTime() - start) / 1000 + " s");
                self.logger.trace("-- Sharelib client side meta info:");
                self.logger.trace(JSON.stringify(config_client));
                self.logger.trace("-- Sharelib server side meta info:");
                self.logger.trace(JSON.stringify(config_server));
                self.logger.trace("-- Sharelib custom controller meta info:");
                self.logger.trace(JSON.stringify(custom_controller));
                //sync write modules info
                writeSeedFile();
                callback();
            }
        );
    }

    // if you want to enable Share Lib YUI Loader,you must have arrow_server start

    if (self.config['enableShareLibYUILoader']) {
        servermgr.getArrowServerStatus(function (isrunning) {
            if (isrunning) {
                startGenerateProcess();
            } else {
                self.logger.info(" Arrow will start arrow_server for you to use share lib YUI Loader");
                servermgr.startArrowServer(function (started) {
                    if (started) {
                        startGenerateProcess();
                    } else {
                        self.logger.error(" Start arrow server failed ,please start it first!");
                        return;
                    }
                });
                // should we stop it ?
            }
        });
    } else {
        startGenerateProcess();
    }
}

/**
 * write seed file and controller info
 * @param cb
 */
function writeSeedFile() {

    //cleanup config to remove those have empty modules info
    var removeEmptyModulesOfConfig = function (config) {
        for (var key in config) {
            if (config.hasOwnProperty(key) &&
                config[key]['modules'] &&
                Object.keys(config[key]['modules']).length === 0) {
                delete config[key];
            }
        }
    }

    if (Object.keys(config_client) !== 0) {
        removeEmptyModulesOfConfig(config_client);
    }
    if (Object.keys(config_server) !== 0) {
        removeEmptyModulesOfConfig(config_server);
    }

    try {
        // client seed
        fs.writeFileSync(scannerUtil.getShareLibClientSideMetaPath(), JSON.stringify(config_client));
        // server seed
        fs.writeFileSync(scannerUtil.getShareLibServerSideMetaPath(), JSON.stringify(config_server));
        // share lib controller
        fs.writeFileSync(scannerUtil.getShareLibControllerPath(), JSON.stringify(custom_controller));

        shareLibLogger.trace("Write sharelib modules meta to folder: " + shareLibMetaPath + " done!");

    } catch (e) {
        shareLibLogger.error("write seed file err:" + e);
    }

}

/**
 * init meta data for scan
 * @param libname libname start with prefix
 */
function initMetaData(libname) {

    var GROUP_ROOT = "";
    // set up for client side base and root
    arrowServerHost = arrowServerHost || servermgr.getArrowServerHost();
//    var GROUP_BASE = arrowServerHost || "http://localhost:10000"; //to be replace if arrow server not started
    var GROUP_BASE = "http://" + ARROW_SERVER_IPADDR_TEMPLATE;
    config_client[libname] = config_client[libname] || {};
    config_client[libname].base = config_client[libname].base || GROUP_BASE + "/arrow/static";
    config_client[libname].root = config_client[libname].root || GROUP_ROOT;
    config_client[libname].modules = config_client[libname].modules || {};

    // set up for server side base and root
    GROUP_BASE = "/";

    config_server[libname] = config_server[libname] || {};
    config_server[libname].base = config_server[libname].base || GROUP_BASE;
    config_server[libname].root = config_server[libname].root || GROUP_ROOT;
    config_server[libname].modules = config_server[libname].modules || {};

}

/**
 * Do scan by given path
 * @param scanlibpath path for scan
 * @param cb
 */
function scan(scanlibpath, cb) {
    // this will scan all folders start with some prefix defined in config
    fs.readdir(scanlibpath, function (err, list) {
        if (err) return cb(err);
        var pending = list.length;
        if (!pending) return cb(null, "empty dir");
        list.forEach(function (f) {
            var file = scanlibpath + '/' + f;
            fs.stat(file, function (err, stat) {   // enable soft link
                if (stat && stat.isDirectory() && !isHiddenFile(f)) {
                    if (!isShareLib(file)) { // recursive scan or not by config
                        if (SHARE_LIB_SCAN_RECURSIVE) {
                            scan(file, function (err, message) {
                                if (err) return cb(err);
                                if (!--pending)  return cb(null, "Scan folder " + scanlibpath + " done!");
                            });
                        } else {
                            if (!--pending)return cb(null, "Scan folder " + scanlibpath + " done!");
                        }
                    } else {
                        // first parames is lib name like share_lib_name,
                        // second parames is lib path like path/to/share_lib_name
                        generateMetaData(f, file, function (err, message) {
                            if (err) {
                                cb(err);
                            } else {
                                if (!--pending) {
                                    return cb(null, "Scan folder " + scanlibpath + " done!");
                                }
                            }
                        });
                    }
                } else {
                    if (!--pending) {
                        return cb(null, "Scan folder " + scanlibpath + " done!");
                    }
                }
            });
        });
    });

}

/**
 * generate meta data for a prefix-ed packages or build-in arrow/sharelib
 * @param libname
 * @param libpath
 * @param done
 */
function generateMetaData(libname, libpath, done) {

    var libhash = calcLibHashByFsPath(libpath);
    if (libhash) {
        libhash = libhash.substring(0, 6); //six digits of MD5 hash is enough
    }
    initMetaData(libhash);

    fs.readdir(libpath, function (err, list) {
        if (err) return done(err);
        var pending = list.length;
        if (!pending) return done(null, "empty dir");
        list.forEach(function (f) {
            var file = libpath + '/' + f;
            fs.stat(file, function (err, stat) {
                if (stat && stat.isDirectory() && !isHiddenFile(f)) {
                    if (isShareLibController(f)) { // should be "controller" folder
                        generateControllersInfo(libname, file, function (err, message) {
                                if (err) {
                                    return done(err);
                                } else {
                                    if (!--pending) {
                                        return done(null, "-- Processing modules " + libpath + " done!");
                                    }
                                }
                            }
                        );
                    } else if (f.toString() === "node_modules") {
                        // for other folders like "node_modules" or others , scan recursive for sharelib
                        scan(file, function (err, message) {
                            if (err) return done(err);
                            if (!--pending) {
                                return done(null, "-- Processing modules " + libpath + " done!");
                            }
                        });
                    } else if (f.toString() === "yahoo-arrow") { // ignore folders like yahoo-arrow
                        if (!--pending) {
                            return done(null, "-- Processing modules " + libpath + " done!");
                        }
                    } else {
                        /*
                         1. it should be standard share lib structure :
                         "lib"
                         ..| - client
                         ..| - server
                         ..| - common

                         2. but if its not ,just a regular folder:
                         "src"
                         ..| - modules1
                         ..| - modules2
                         ..| - yui-mod.js
                         we will still generate YUI groups info and set as "common". then all these yui
                         modules can still be used.
                         */
                        generateYUIGroupsInfo(libhash, file, function (err, message) {
                            if (err) {
                                return done(err);
                            } else {
                                if (!--pending) {
                                    return done(null, "-- Processing modules " + libpath + " done!");
                                }
                            }
                        });
                    }
                } else if (stat && stat.isFile() && !isHiddenFile(f)) {
                    getYUIFileMetaData(libhash, file, "common");
                    if (!--pending) {
                        return done(null, "-- Processing modules " + libpath + " done!");
                    }
                } else {
                    if (!--pending) {
                        return done(null, "-- Processing modules " + libpath + " done!");
                    }
                }
            });
        });
    });
}

/**
 * for a single file ,get its meta data and put it in config object
 * @param fspath
 */
function getYUIFileMetaData(fshash, fspath, affnity) {
    affnity = affnity || "common";
    var yuimodule = captureYUIModuleDetails(fspath);
    if (yuimodule && yuimodule.name) { // for those non-yui js file, will returen as null
        if (affnity == 'common' || affnity == 'server') {
            var moduledetail = config_server[fshash].modules[yuimodule.name] || {};
            moduledetail.path = fspath;
            moduledetail.requires = yuimodule.meta.requires || [];
            config_server[fshash].modules[yuimodule.name] = moduledetail;
        }
        if (affnity == 'common' || affnity == 'client') {
            var moduledetail = config_client[fshash].modules[yuimodule.name] || {};
            moduledetail.path = fspath;
            moduledetail.requires = yuimodule.meta.requires || [];
            config_client[fshash].modules[yuimodule.name] = moduledetail;
        }
    }
}

/**
 * generate meta data for a share lib modules or build-in sharelib
 * @param libname
 * @param libpath
 * @param done
 */
function generateYUIGroupsInfo(libhash, libpath, done) {

    fs.readdir(libpath, function (err, list) {
        if (err) return done(err);
        var pending = list.length;
        if (!pending) return done(null, "empty dir");
        list.forEach(function (f) {
            var file = libpath + '/' + f;
            fs.stat(file, function (err, stat) {
                if (stat && stat.isDirectory() && !isHiddenFile(f)) {

                    // NOTE:
                    // its strongly recommended that users organize all yui file in client/server/common way to avoid mistakes

                    var affnity = f.toString(); // should be server,common,client or other folder
                    if (!isShareLibYUIModule(f)) {
                        affnity = "common"  // for these folders that don't match client/server/common will be added to common
                    }
                    walk(file, function (err, results) {
                        if (err) {
                            return done(err);
                        } else {
                            if (results && results.length > 0) {
                                results.forEach(function (fspath) {
                                    getYUIFileMetaData(libhash, fspath, affnity);
                                })
                            }
                            if (!--pending) {
                                return done(null, "-- Processing yui lib " + libpath + " done!");
                            }
                        }
                    });
                } else if (stat && stat.isFile() && !isHiddenFile(f)) { // single file
                    getYUIFileMetaData(libhash, file, "common");
                    if (!--pending) {
                        return done(null, "-- Processing yui lib " + libpath + " done!");
                    }
                } else {
                    if (!--pending) {
                        return done(null, "-- Processing yui lib " + libpath + " done!");
                    }
                }
            });
        });
    });
}

/**
 * generate meta data of controller under a share lib pkg or build-in sharelib
 * @param libname pkg name
 * @param file controller folder path
 * @param done
 */
function generateControllersInfo(libname, file, done) {
    var ctrller_name;
    fs.readdir(file, function (err, list) {
        if (err) return done(err);
        list.forEach(function (f) {
            var ctrller = file + '/' + f;
            fs.stat(ctrller, function (err, stat) {
                if (stat && stat.isFile() && f.substr(-3) == '.js') {
                    ctrller_name = f.substr(0, f.lastIndexOf('.'));
                    // note: if is build-in share-lib controller,then users can use them without a package name
                    if (isShareLibBuildInController(file)) {
                        ctrller_name = f.substr(0, f.lastIndexOf('.'));
                    }
                    custom_controller[ctrller_name] = custom_controller[ctrller_name] || {};
                    custom_controller[ctrller_name].path = ctrller;
                }
            });
        });
        return done(null, "Generate controller info done");
    });
}

/**
 * recursively walk the dir to get file list
 * @param dir
 * @param done
 */
function walk(dir, done) {
    var results = [];
    fs.readdir(dir, function (err, list) {
        if (err) return done(err);
        var pending = list.length;
        if (!pending) return done(null, results);
        list.forEach(function (f) {
            var file = dir + '/' + f;
            fs.stat(file, function (err, stat) {
                if (stat && stat.isDirectory()) {
                    if (isHiddenFile(f)) {
                        if (!--pending) done(null, results);
                        return;
                    }
                    walk(file, function (err, res) {
                        if (err) return done(err);
                        results = results.concat(res);
                        if (!--pending) done(null, results);
                    });
                } else {
                    // generate meta config file
                    if (!(f.substr(-3) == '.js') || isHiddenFile(f)) { //ignore non-js file
                        if (!--pending) done(null, results);
                        return;
                    }
                    results.push(file);
                    if (!--pending) done(null, results);
                }
            });
        });
    });
};

var contextForRunInContext = libvm.createContext({
    require: require,
    module: require('module'),
    console: {
        log: function () {
        }
    },
    window: {},
    document: {},
    YUI: null
});

/**
 * get yui modules details
 * @param filePath file path to js file
 * @return {Object}
 */
function captureYUIModuleDetails(filePath) {
    var file,
        yui = {};
    try {
        file = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        shareLibLogger.error(e);
        return null;
    }
    // setting up the fake YUI before executing the file
    contextForRunInContext.YUI = {
        ENV: {},
        config: {},
        use: function () {
        },
        add: function (name, fn, version, meta) {
            yui.name = name;
            yui.version = version;
            yui.meta = meta || {};
            if (!yui.meta.requires) {
                yui.meta.requires = [];
            }
        }
    };
    try {
        libvm.runInContext(file, contextForRunInContext, filePath);
    } catch (e) {
        yui = null;
        shareLibLogger.trace('File: ' + filePath + ' is not standard yui file ,can not parse it,error message is: ' + e.message);
    }
    return yui;
}

scannerUtil.captureYUIModuleDetails = captureYUIModuleDetails;
/**
 * get yui modules details if the file has mutiple yui add/use
 * @param filePath file path to js file
 * @return {Object}
 */
function captureMutipleYUIModuleDetails(filePath) {
    var file,
        yui = {},
        yreq = [];
    try {
        file = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        shareLibLogger.error(e);
        return null;
    }
    // setting up the fake YUI before executing the file
    // in case some YUI().use('...')
    contextForRunInContext.YUI = function () {
        return {
            ENV: {},
            config: {},
            use: function () {
                var args = Array.prototype.slice.call(arguments, 0);
                args.pop(); // pop callback
                yreq = yreq.concat(args);
            },
            add: function (name, fn, version, meta) {
                // YUI().add(name,cb(){},ver,meta)
                yui.name = name;
                yui.version = version;
                yui.meta = meta || {};
                if (!yui.meta.requires) {
                    yui.meta.requires = [];
                }
                yreq = yreq.concat(yui.meta.requires);
            }
        }
    };
    // for standard YUI.add('...');
    contextForRunInContext.YUI.add = function (name, fn, version, meta) {
        yui.name = name;
        yui.version = version;
        yui.meta = meta || {};
        if (!yui.meta.requires) {
            yui.meta.requires = [];
        }
        yreq = yreq.concat(yui.meta.requires);
    };
    try {
        libvm.runInContext(file, contextForRunInContext, filePath);
    } catch (e) {
        yreq = [];
        shareLibLogger.trace('Code in file: ' + filePath + ' is not written in standard YUI add method, we suggest to wrap your code within YUI.add(\'...\') ' +
            'Error message: \n' + e.message);
    }
    return yreq;
}

/**
 * get the source code by given a libname and affnity
 * @param libname
 * @param affnity
 */
function getShareLibSourcePath(libname, affnity) {

    var server_config = {},
        client_config = {},
        foundLibs = [];
    try {
        server_config = require(scannerUtil.getShareLibServerSideMetaPath());
    } catch (e) {
        shareLibLogger.trace("Can't find server config file :" + SERVER_CONFIG_NAME + " in: " + shareLibMetaPath + " error: " + e);
    }
    try {
        client_config = require(scannerUtil.getShareLibClientSideMetaPath());
    } catch (e) {
        shareLibLogger.trace("Can't find client config file :" + CLIENT_CONFIG_NAME + " in: " + shareLibMetaPath + " error: " + e);
    }

    function findSrcFromSeed(config, libname, affnity) {

        shareLibLogger.trace("-- Finding share lib path by libname: " + libname + " , affnity: " + affnity);

        var libs = [],
            contains = function (a, obj) {
                for (var i = 0; i < a.length; i++) {
                    if (a[i] === obj) {
                        return true;
                    }
                }
                return false;
            };

        (function findLibInConfig(config, libname, affnity) {
            var lib;
            for (var key in config) {
                if (config.hasOwnProperty(key) &&
                    config[key]['modules'] &&
                    config[key]['modules'][libname]) { //find libname

                    // if dumplicated,then dont add to libs
                    if (contains(libs, config[key]['modules'][libname].path)) continue;

                    libs.push(config[key]['modules'][libname].path);

                    if (config[key]['modules'][libname].requires) {
                        for (var i = 0; i < config[key]['modules'][libname].requires.length; i++) {

                            lib = findLibInConfig(config, config[key]['modules'][libname].requires[i], affnity);

                            if (lib && lib.length > 0) {
                                for (var k = 0; k < lib.length; k++) {
                                    if (!contains(libs, lib[k]))libs.push(lib[k]);
                                }
                            }
                        }
                    }
                }
            }
        })(config, libname, affnity);
        return libs;
    };

    if (!libname)return shareLibLogger.error("lib name not given");

    affnity = affnity || "common";
    if (affnity === "server" || affnity === "common") {
        foundLibs = findSrcFromSeed(server_config, libname, affnity);
    } else if (affnity === "client") {
        foundLibs = findSrcFromSeed(client_config, libname, affnity);
    } else {
        shareLibLogger.trace("Unknown affnity");
    }
    if (foundLibs && foundLibs.length > 0)shareLibLogger.trace("-- Found share lib path: " + foundLibs);
    return foundLibs || [];
}

/**
 *  get lib's dependency and get its content from share lib;
 * @param libpath
 * @return {String}
 */
scannerUtil.getSrcDependencyByPath = function getSrcDependencyByPath(libpath, affnity) {

    var allDeps = {},
        shareLibsJs = [],
        yreq = captureMutipleYUIModuleDetails(libpath),
        i,
        j;

    /*
     NOTES:
     yreq is the field in yui.add(...,require:[...]);
     it may be share lib yui, or yui-core module or use-defined yui module
     1. for share lib yui modules, we will get it from scanned share lib config
     2. for yui -core modules, we will use yui loader to resolve all its dependency.
     3. for use-defined yui module,will be directly added to driverjs.
     4. for special filed like http://chaijs.com/chai.js , we can record them and pass to arrow
     */

    /*
        show more by graph:

        lib.js -- require:
                       |
                    core-mod1   --- add to yuiDepLibs , load from yui loader
                    core-mod2   --- add to yuiDepLibs, load from yui loader
                       |
                    user-mod1   --- loaded by specify --lib or commonlib
                    user-mod2   --- loaded by specify --lib or commonlib
                       |
                    url1        --- add to urlDepLibs, parsed and pass to arrow
                    url2        --- add to urlDepLibs, parsed and pass to arrow
                       |
                    sharelib1   ---  require:  (add to shareDepLibs)
                         | -----------  core-mod3  -- add to yuiDepLibs , load from yui loader
                         | -----------  core-mod4  -- add to yuiDepLibs , load from yui loader
                         | -----------  sharelib3  -- recusively find in config and add to shareDepLibs
                         | -----------  sharelib4  -- recusively find in config and add to shareDepLibs
                                            | ----  core-mod5
                                            | ----  sharelib5


        in  shareDepLibs it should have :  sharelib1, sharelib3,shareib4,sharelib5
        in  yuiDepLibs   it should have :  core-mod1,core-mod2,user-mod1,user-mod2,sharelib1,core-mod3,core-mod4,sharelib3,sharelib4,core-mod5,sharelib5
        in  urlDepLibs   it should have :  url1,url2

     */

    allDeps.yuiDepLibs = yreq || [];
    allDeps.urlDepLibs = [];

    if (yreq && yreq.length > 0) {
        for (i = 0; i < yreq.length; i++) {
            if (/^(http|ftp|https):\/\/.*\.js$/.test(yreq[i])) {  // see NOTES:4
                allDeps.urlDepLibs = allDeps.urlDepLibs.concat(yreq[i]);
            } else {
                shareLibsJs = shareLibsJs.concat(getShareLibSourcePath(yreq[i], affnity));
            }
        }
    }
    allDeps.shareDepLibs = [];

    // if we get two share lib named: a:require(b,c), d-require(e,f,g)
    // we should also resolve b,c,e,f,g whether they are core-modules or another share lib
    if (shareLibsJs && shareLibsJs.length > 0) {
        allDeps.shareDepLibs = shareLibsJs;
        for (i = 0; i < shareLibsJs.length; i++) {
            yreq = captureMutipleYUIModuleDetails(shareLibsJs[i]) || [];
            if (yreq && yreq.length > 0) {
                for (j = 0; j < yreq.length; j++) {
                    if (/^(http|ftp|https):\/\/.*\.js$/.test(yreq[j])) {
                        allDeps.urlDepLibs = allDeps.urlDepLibs.concat(yreq[j]);
                    } else {
                        allDeps.yuiDepLibs = allDeps.yuiDepLibs.concat(yreq[j]);
                    }
                }
            }
        }
    }
    return allDeps;
}


/**
 *  resolve YUI Denpendency by given "require" filed;
 * @param yuideps like ['test','oop',...]
 * @param opts options for loader
 * @param cb function
 */
scannerUtil.resolveYUIDenpendency = function resolveYUIDenpendency(yuideps, opts, cb) {

    var Y = require('yui').YUI(),
        YIO = require('yui/io-base'),
        yuiout,
        yuisrc = "",
        yuiversion = opts.version || '3.8.0',
        LOCAL_BASE = path.join(ARROW_MODULES_ROOT, "node_modules", "yui"),
        CDN_BASE = 'http://yui.yahooapis.com/' + yuiversion + "/build",
        loader;
    if (yuiversion !== Y.version) {
        LOCAL_BASE = CDN_BASE; // force to load from CDN.
    }
    loader = new Y.Loader({
        //Don't combine the files
        base: LOCAL_BASE + "/",
        combine: false,
        // load from fs,not need combo server
        comboBase: 'http://yui.yahooapis.com/combo?',
        //Ignore things that are already loaded (in this process)
        ignoreRegistered: opts.ignoreRegistered || true,
        require: yuideps
    });
    yuiout = loader.resolve(true);

    if (yuiout && yuiout.js) {

        function downloadjs(url, cb) {
            YIO.io(url, {
                method: 'GET',
                timeout: 5000,
                on: {
                    success: function (id, e) {
                        // Signals an HTTP response with status in the 2xx range.
                        cb(null, e.responseText);
                    },
                    end: function (id, e) {
                    },
                    failure: function (id, e) {
                        cb("Http GET request to " + url + " failure,this yui modules can't be added to closure");
                    }
                }
            });
        }

        /*
         First we resolve yui modules to like arrow/node_modules/yui/yui-base/yui-base-min.js
         If read file system failed,we load it from http://yui.yahooapis.com/3.6.0/build/yui-base/yui-base-min.js
         If still failed, give error message
         */
        sync.forEachSeries(yuiout.js, function (url, finishone) {
                try {
                    //  have to use read sync cause the resolved yui modules has sequence itself.
                    yuisrc += fs.readFileSync(path.normalize(url), 'utf8');
                    shareLibLogger.trace("Read file from " + url + " sucess!");
                    finishone();
                } catch (e) {
                    url = CDN_BASE + url.replace(LOCAL_BASE, "");
                    shareLibLogger.trace("Read file " + url + " failed:\n" + e + ",\ntry send request to " + url);
                    downloadjs(url, function (error, src) {
                        if (error) {
                            shareLibLogger.error(error);
                        } else {
                            yuisrc += src.toString();
                        }
                        finishone();
                    });
                }
            }, function () {
                if (yuisrc.length > 0 && yuisrc !== "") {
                    cb(null, yuisrc);
                } else {
                    cb("Download yui runtime js error!" +
                        "Please check if your network has access to " +
                        "http://yui.yahooapis.com/3.6.0/build/yui/yui-min.js ");
                }
            }
        );
    }
}
/**
 * get Share Lib Client Side Modules Meta
 * @return {*}
 */
scannerUtil.getShareLibClientSideModulesMeta = function getShareLibClientSideModulesMeta() {

    var client_template =
        'var SCANNED_YUI_GROUP=%client%;' +
            'if(!YUI){' +
            'YUI_config={' +
            'groups:SCANNED_YUI_GROUP' + '}' +
            '}' + 'else{' +
            'YUI.GlobalConfig = {' +
            'groups:SCANNED_YUI_GROUP' +
            '}}' + "\n";

    try {
        var shareLibClientSeedJs = fs.readFileSync(scannerUtil.getShareLibClientSideMetaPath(), "utf-8");
        return client_template.replace(/%client%/g, shareLibClientSeedJs);
    } catch (e) {
        shareLibLogger.error("No client side share lib seed file found");
    }
    return "";
}

/**
 * get Share Lib Server Side Modules Meta
 * @return {*}
 */
scannerUtil.getShareLibServerSideModulesMeta = function getShareLibServerSideModulesMeta() {

    var server_template = 'YUI = YUI ? YUI : require(\'yui\').YUI;' +
            'YUI.GlobalConfig = {' +
            'groups:%server%' +
            '}' + "\n",
        serverseedfile = path.join(shareLibMetaPath, "server_seed.js");
    try {
        var shareLibServerSeedJs = fs.readFileSync(scannerUtil.getShareLibServerSideMetaPath(), "utf-8");
        fs.writeFileSync(serverseedfile, server_template.replace(/%server%/g, shareLibServerSeedJs));
    } catch (e) {
        shareLibLogger.error("No server side share lib seed file found");
    }
    return serverseedfile;
}

/**
 * inject yui loader checker js into page
 * @param checkerpath
 * @return {*}
 */
scannerUtil.createYuiLoaderCheckerJS = function createYuiLoaderCheckerJS() {

    var checkerpath = path.join(ARROW_MODULES_ROOT, "lib/client/yuitest-yuiloadercheck.js"),
        portcheckcode;

    try {
        portcheckcode = fs.readFileSync(checkerpath, "utf-8");
    } catch (e) {
        shareLibLogger.error("Read yui loader check file  err: " + e);
        throw e;
    }

    var serverip = servermgr.getArrowServerHostIP();
    var aviableips = servermgr.getAllIPAddressForArrowServer();
    // get all avaiable ips and let it check in the page
    if (aviableips && aviableips.length > 1) {
        var port = "10000";
        if (serverip && serverip.split(":").length > 1) {
            port = serverip.split(":")[1];
        }
        aviableips = aviableips.map(function (item) {
            return item + ":" + port;
        });
        aviableips = aviableips.join("\',\'");
    } else {
        aviableips = serverip;
    }

    shareLibLogger.trace("Available ip/port address are: " + aviableips);

    var yuigroupconfig = scannerUtil.getShareLibClientSideModulesMeta().
        replace(/ARROW_SERVER_IPADDR/g, "\"+" + ARROW_SERVER_IPADDR_TEMPLATE + "+\"");

    var shareLibClientSeedJs =
        "\n" + "function resetYUIGroupBase(ARROW_SERVER_IPADDR) {\n" +
            " var ARROW_SERVER_IPADDR = ARROW_SERVER_IPADDR;\n" +
            yuigroupconfig +
            "}\n" +
            "var ARROW_SERVER_IP_ADDR_ALL=[\'" + aviableips + "\'];\n" +
            portcheckcode + ";\n";
    return shareLibClientSeedJs;

}

module.exports = sharelibscanner;
module.exports.scannerUtil = scannerUtil;
