let config = require('./config.js');
let http = require('http');
let chalk = require('chalk');
let path = require('path');
let fs = require('fs');
let url = require('url');
let zlib = require('zlib');
let { promisify, inspect } = require('util');
let mime = require('mime');
let handlebars = require('handlebars');
let stat = promisify(fs.stat);
let readdir = promisify(fs.readdir);
let crypto = require('crypto');

process.env.DEBUG = 'static:app'

// 编译模板，得到一个渲染的方法，然后传入实际数据就可以得到渲染后的html了
function list() {
    let tmp = fs.readFileSync(path.resolve(__dirname, 'template', 'list.html'), 'utf8');
    return handlebars.compile(tmp);
}
// 这是一个在控制台输出的模块，名称有特点有两部分组成，第一部分一般是项目名，第二部分是模块名
// 每个debug实例都有一个名字，是否控制台打印取决于环境变量中DEBUG的值是否等于static:app
let debug = require('debug')('static:app');
// console.log(process.env);
// 创建一个服务器
/**
 * 1、显示目录下面的文件列表和返回内容
 * 2、实现压缩的功能
 * 3、缓存
 */
class Server{
    constructor(argv) {
        this.list = list();
        this.config = Object.assign({}, config, argv);
    }
    start() {
        let server = http.createServer();
        server.on('request', this.request.bind(this));
        server.listen(this.config.port, () => {
            let url = `${this.config.host}: ${this.config.port}`
            debug(`server started at ${chalk.green(url)}`)
        });
    }
    // 静态文件服务器
    async request(req, res) {
        // 先取到客户端想访问的文件或者文件夹路径
        let { pathname } = url.parse(req.url);
        let filePath = path.join(this.config.root, pathname);
        try {
            let statObj = await stat(filePath);  
            if (statObj.isDirectory()) { // 如果是目录的话，应该显示目录下面的文件列表
                let files = await readdir(filePath);
                files = files.map((file) => ({
                    name: file,
                    url: path.join(pathname, file)
                }))
                
                let html = this.list({
                    title: pathname,
                    files
                })
                res.setHeader('Content-Type', 'text/html');
                res.end(html);
            } else {
                this.sendFile(req, res, filePath, statObj);
            }
        } catch (error) {
            debug(inspect(error)); // inspect把一个对象转成一个字符串
            this.sendError(req, res);
        }
    }
    async sendFile(req, res, filePath, statObj) {
        let handleCache = promisify(this.handleCache);
        if (await handleCache(req, res, filePath, statObj)) return; // 如果走缓存，直接返回
        res.setHeader('Content-Type', mime.getType(filePath));
        let stream = this.getStream(req, res, filePath, statObj);
        let encoding = this.getEncoding(req, res);
        if (encoding) {
            stream.pipe(encoding).pipe(res);
        } else {
            stream.pipe(res);
        }
    }
    sendError(req, res) {
        res.statusCode = 500;
        res.end('there is something wrong in the server! please try later!')
    }
    getEncoding(req, res) {
        // Accept-Encoding: gzip, deflate
        let acceptEncoding = req.headers['accept-encoding'];
        if (/\bgzip\b/.test(acceptEncoding)) {
            res.setHeader('Content-Encoding', 'gzip');
            return zlib.createGzip();
        } else if (/\bdeflate\b/.test(acceptEncoding)) {
            res.setHeader('Content-Encoding', 'deflate');
            return zlib.createDeflate();
        } else {
            return null;
        }
    }
    getStream(req, res, filePath, statObj) {
        res.setHeader('Accept-Range', 'bytes'); // 告诉客户端服务器支持Range(断点续传)
        let range = req.headers['range']; // 获取请求头中到的range字段
        let start = 0;
        let end = statObj.size;
        if (range) {
            let reg = /bytes=(\d*)-(\d*)/;
            let result = range.match(reg);
            if (result) {
                start = isNaN(result[1]) ? 0 : parseInt(result[1]);
                end = isNaN(result[2]) ? 0 : parseInt(result[2]);
            }   
        }
        debug(`start=${start},end=${end}`);
        return fs.createReadStream(filePath, {
            start,
            end
        });
    }
    handleCache(req, res, filePath, statObj, callback) {
        /**
         * MemoryCache顾名思义，就是将资源缓存到内存中，等待下次访问时不需要重新下载资源，而直接从内存中获取。
         * 不请求网络资源，资源在内存当中，一般脚本、字体、图片会存在内存当中
         * 
         * 
         * diskCache顾名思义，就是将资源缓存到磁盘中，等待下次访问时不需要重新下载资源，而直接从磁盘中获取，它的直接操作对象为CurlCacheManager。它与memoryCache最大的区别在于，
         * 当退出进程时，内存中的数据会被清空，而磁盘的数据不会，所以，当下次再进入该进程时，该进程仍可以从diskCache中获得数据，而memoryCache则不行。 
         * 不请求网络资源，在磁盘当中，一般非脚本会存在内存当中，如css等
         */
        
        // return new Promise(function(resolve, reject) {
            // 设置强制缓存
            res.setHeader('Cache-Control', 'private,max-age=10');
            res.setHeader('Expires', new Date(Date.now() + 10 * 1000).toGMTString());

            // 根据时间比较
            let ifModifiedSince = req.headers['if-modified-since'];
            let lastModified= statObj.ctime.toGMTString();

            let isNoneMatch = req.headers['if-none-match'];
            let etag;
            let out = fs.createReadStream(filePath);
            let md5 = crypto.createHash('md5');
            out.on('data', function(data) {
                md5.update(data)
            })
            out.on('end', function() {
                etag = md5.digest('hex');
                if (etag == isNoneMatch || lastModified == ifModifiedSince) {
                    res.writeHead(304);
                    res.end();
                    // resolve(true)
                    typeof callback == 'function' && callback(true)
                } else {
                    res.setHeader('last-Modified', lastModified);
                    res.setHeader('Etag', etag);
                    // resolve(false);
                    typeof callback == 'function' && callback(false)
                }
            })
        // })
    }
}
// let server = new Server();
// server.start();
module.exports = Server;