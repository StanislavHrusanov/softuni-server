(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory(require('http'), require('fs'), require('crypto')) :
        typeof define === 'function' && define.amd ? define(['http', 'fs', 'crypto'], factory) :
            (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.Server = factory(global.http, global.fs, global.crypto));
}(this, (function (http, fs, crypto) {
    'use strict';

    function _interopDefaultLegacy(e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

    var http__default = /*#__PURE__*/_interopDefaultLegacy(http);
    var fs__default = /*#__PURE__*/_interopDefaultLegacy(fs);
    var crypto__default = /*#__PURE__*/_interopDefaultLegacy(crypto);

    class ServiceError extends Error {
        constructor(message = 'Service Error') {
            super(message);
            this.name = 'ServiceError';
        }
    }

    class NotFoundError extends ServiceError {
        constructor(message = 'Resource not found') {
            super(message);
            this.name = 'NotFoundError';
            this.status = 404;
        }
    }

    class RequestError extends ServiceError {
        constructor(message = 'Request error') {
            super(message);
            this.name = 'RequestError';
            this.status = 400;
        }
    }

    class ConflictError extends ServiceError {
        constructor(message = 'Resource conflict') {
            super(message);
            this.name = 'ConflictError';
            this.status = 409;
        }
    }

    class AuthorizationError extends ServiceError {
        constructor(message = 'Unauthorized') {
            super(message);
            this.name = 'AuthorizationError';
            this.status = 401;
        }
    }

    class CredentialError extends ServiceError {
        constructor(message = 'Forbidden') {
            super(message);
            this.name = 'CredentialError';
            this.status = 403;
        }
    }

    var errors = {
        ServiceError,
        NotFoundError,
        RequestError,
        ConflictError,
        AuthorizationError,
        CredentialError
    };

    const { ServiceError: ServiceError$1 } = errors;


    function createHandler(plugins, services) {
        return async function handler(req, res) {
            const method = req.method;
            console.info(`<< ${req.method} ${req.url}`);

            // Redirect fix for admin panel relative paths
            if (req.url.slice(-6) == '/admin') {
                res.writeHead(302, {
                    'Location': `http://${req.headers.host}/admin/`
                });
                return res.end();
            }

            let status = 200;
            let headers = {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            };
            let result = '';
            let context;

            // NOTE: the OPTIONS method results in undefined result and also it never processes plugins - keep this in mind
            if (method == 'OPTIONS') {
                Object.assign(headers, {
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Credentials': false,
                    'Access-Control-Max-Age': '86400',
                    'Access-Control-Allow-Headers': 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, X-Authorization, X-Admin'
                });
            } else {
                try {
                    context = processPlugins();
                    await handle(context);
                } catch (err) {
                    if (err instanceof ServiceError$1) {
                        status = err.status || 400;
                        result = composeErrorObject(err.code || status, err.message);
                    } else {
                        // Unhandled exception, this is due to an error in the service code - REST consumers should never have to encounter this;
                        // If it happens, it must be debugged in a future version of the server
                        console.error(err);
                        status = 500;
                        result = composeErrorObject(500, 'Server Error');
                    }
                }
            }

            res.writeHead(status, headers);
            if (context != undefined && context.util != undefined && context.util.throttle) {
                await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
            }
            res.end(result);

            function processPlugins() {
                const context = { params: {} };
                plugins.forEach(decorate => decorate(context, req));
                return context;
            }

            async function handle(context) {
                const { serviceName, tokens, query, body } = await parseRequest(req);
                if (serviceName == 'admin') {
                    return ({ headers, result } = services['admin'](method, tokens, query, body));
                } else if (serviceName == 'favicon.ico') {
                    return ({ headers, result } = services['favicon'](method, tokens, query, body));
                }

                const service = services[serviceName];

                if (service === undefined) {
                    status = 400;
                    result = composeErrorObject(400, `Service "${serviceName}" is not supported`);
                    console.error('Missing service ' + serviceName);
                } else {
                    result = await service(context, { method, tokens, query, body });
                }

                // NOTE: logout does not return a result
                // in this case the content type header should be omitted, to allow checks on the client
                if (result !== undefined) {
                    result = JSON.stringify(result);
                } else {
                    status = 204;
                    delete headers['Content-Type'];
                }
            }
        };
    }



    function composeErrorObject(code, message) {
        return JSON.stringify({
            code,
            message
        });
    }

    async function parseRequest(req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const tokens = url.pathname.split('/').filter(x => x.length > 0);
        const serviceName = tokens.shift();
        const queryString = url.search.split('?')[1] || '';
        const query = queryString
            .split('&')
            .filter(s => s != '')
            .map(x => x.split('='))
            .reduce((p, [k, v]) => Object.assign(p, { [k]: decodeURIComponent(v) }), {});
        const body = await parseBody(req);

        return {
            serviceName,
            tokens,
            query,
            body
        };
    }

    function parseBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk) => body += chunk.toString());
            req.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    resolve(body);
                }
            });
        });
    }

    var requestHandler = createHandler;

    class Service {
        constructor() {
            this._actions = [];
            this.parseRequest = this.parseRequest.bind(this);
        }

        /**
         * Handle service request, after it has been processed by a request handler
         * @param {*} context Execution context, contains result of middleware processing
         * @param {{method: string, tokens: string[], query: *, body: *}} request Request parameters
         */
        async parseRequest(context, request) {
            for (let { method, name, handler } of this._actions) {
                if (method === request.method && matchAndAssignParams(context, request.tokens[0], name)) {
                    return await handler(context, request.tokens.slice(1), request.query, request.body);
                }
            }
        }

        /**
         * Register service action
         * @param {string} method HTTP method
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        registerAction(method, name, handler) {
            this._actions.push({ method, name, handler });
        }

        /**
         * Register GET action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        get(name, handler) {
            this.registerAction('GET', name, handler);
        }

        /**
         * Register POST action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        post(name, handler) {
            this.registerAction('POST', name, handler);
        }

        /**
         * Register PUT action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        put(name, handler) {
            this.registerAction('PUT', name, handler);
        }

        /**
         * Register PATCH action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        patch(name, handler) {
            this.registerAction('PATCH', name, handler);
        }

        /**
         * Register DELETE action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        delete(name, handler) {
            this.registerAction('DELETE', name, handler);
        }
    }

    function matchAndAssignParams(context, name, pattern) {
        if (pattern == '*') {
            return true;
        } else if (pattern[0] == ':') {
            context.params[pattern.slice(1)] = name;
            return true;
        } else if (name == pattern) {
            return true;
        } else {
            return false;
        }
    }

    var Service_1 = Service;

    function uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            let r = Math.random() * 16 | 0,
                v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    var util = {
        uuid
    };

    const uuid$1 = util.uuid;


    const data = fs__default['default'].existsSync('./data') ? fs__default['default'].readdirSync('./data').reduce((p, c) => {
        const content = JSON.parse(fs__default['default'].readFileSync('./data/' + c));
        const collection = c.slice(0, -5);
        p[collection] = {};
        for (let endpoint in content) {
            p[collection][endpoint] = content[endpoint];
        }
        return p;
    }, {}) : {};

    const actions = {
        get: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            let responseData = data;
            for (let token of tokens) {
                if (responseData !== undefined) {
                    responseData = responseData[token];
                }
            }
            return responseData;
        },
        post: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            console.log('Request body:\n', body);

            // TODO handle collisions, replacement
            let responseData = data;
            for (let token of tokens) {
                if (responseData.hasOwnProperty(token) == false) {
                    responseData[token] = {};
                }
                responseData = responseData[token];
            }

            const newId = uuid$1();
            responseData[newId] = Object.assign({}, body, { _id: newId });
            return responseData[newId];
        },
        put: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            console.log('Request body:\n', body);

            let responseData = data;
            for (let token of tokens.slice(0, -1)) {
                if (responseData !== undefined) {
                    responseData = responseData[token];
                }
            }
            if (responseData !== undefined && responseData[tokens.slice(-1)] !== undefined) {
                responseData[tokens.slice(-1)] = body;
            }
            return responseData[tokens.slice(-1)];
        },
        patch: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            console.log('Request body:\n', body);

            let responseData = data;
            for (let token of tokens) {
                if (responseData !== undefined) {
                    responseData = responseData[token];
                }
            }
            if (responseData !== undefined) {
                Object.assign(responseData, body);
            }
            return responseData;
        },
        delete: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            let responseData = data;

            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                if (responseData.hasOwnProperty(token) == false) {
                    return null;
                }
                if (i == tokens.length - 1) {
                    const body = responseData[token];
                    delete responseData[token];
                    return body;
                } else {
                    responseData = responseData[token];
                }
            }
        }
    };

    const dataService = new Service_1();
    dataService.get(':collection', actions.get);
    dataService.post(':collection', actions.post);
    dataService.put(':collection', actions.put);
    dataService.patch(':collection', actions.patch);
    dataService.delete(':collection', actions.delete);


    var jsonstore = dataService.parseRequest;

    /*
     * This service requires storage and auth plugins
     */

    const { AuthorizationError: AuthorizationError$1 } = errors;



    const userService = new Service_1();

    userService.get('me', getSelf);
    userService.post('register', onRegister);
    userService.post('login', onLogin);
    userService.get('logout', onLogout);


    function getSelf(context, tokens, query, body) {
        if (context.user) {
            const result = Object.assign({}, context.user);
            delete result.hashedPassword;
            return result;
        } else {
            throw new AuthorizationError$1();
        }
    }

    function onRegister(context, tokens, query, body) {
        return context.auth.register(body);
    }

    function onLogin(context, tokens, query, body) {
        return context.auth.login(body);
    }

    function onLogout(context, tokens, query, body) {
        return context.auth.logout();
    }

    var users = userService.parseRequest;

    const { NotFoundError: NotFoundError$1, RequestError: RequestError$1 } = errors;


    var crud = {
        get,
        post,
        put,
        patch,
        delete: del
    };


    function validateRequest(context, tokens, query) {
        /*
        if (context.params.collection == undefined) {
            throw new RequestError('Please, specify collection name');
        }
        */
        if (tokens.length > 1) {
            throw new RequestError$1();
        }
    }

    function parseWhere(query) {
        const operators = {
            '<=': (prop, value) => record => record[prop] <= JSON.parse(value),
            '<': (prop, value) => record => record[prop] < JSON.parse(value),
            '>=': (prop, value) => record => record[prop] >= JSON.parse(value),
            '>': (prop, value) => record => record[prop] > JSON.parse(value),
            '=': (prop, value) => record => record[prop] == JSON.parse(value),
            ' like ': (prop, value) => record => record[prop].toLowerCase().includes(JSON.parse(value).toLowerCase()),
            ' in ': (prop, value) => record => JSON.parse(`[${/\((.+?)\)/.exec(value)[1]}]`).includes(record[prop]),
        };
        const pattern = new RegExp(`^(.+?)(${Object.keys(operators).join('|')})(.+?)$`, 'i');

        try {
            let clauses = [query.trim()];
            let check = (a, b) => b;
            let acc = true;
            if (query.match(/ and /gi)) {
                // inclusive
                clauses = query.split(/ and /gi);
                check = (a, b) => a && b;
                acc = true;
            } else if (query.match(/ or /gi)) {
                // optional
                clauses = query.split(/ or /gi);
                check = (a, b) => a || b;
                acc = false;
            }
            clauses = clauses.map(createChecker);

            return (record) => clauses
                .map(c => c(record))
                .reduce(check, acc);
        } catch (err) {
            throw new Error('Could not parse WHERE clause, check your syntax.');
        }

        function createChecker(clause) {
            let [match, prop, operator, value] = pattern.exec(clause);
            [prop, value] = [prop.trim(), value.trim()];

            return operators[operator.toLowerCase()](prop, value);
        }
    }


    function get(context, tokens, query, body) {
        validateRequest(context, tokens);

        let responseData;

        try {
            if (query.where) {
                responseData = context.storage.get(context.params.collection).filter(parseWhere(query.where));
            } else if (context.params.collection) {
                responseData = context.storage.get(context.params.collection, tokens[0]);
            } else {
                // Get list of collections
                return context.storage.get();
            }

            if (query.sortBy) {
                const props = query.sortBy
                    .split(',')
                    .filter(p => p != '')
                    .map(p => p.split(' ').filter(p => p != ''))
                    .map(([p, desc]) => ({ prop: p, desc: desc ? true : false }));

                // Sorting priority is from first to last, therefore we sort from last to first
                for (let i = props.length - 1; i >= 0; i--) {
                    let { prop, desc } = props[i];
                    responseData.sort(({ [prop]: propA }, { [prop]: propB }) => {
                        if (typeof propA == 'number' && typeof propB == 'number') {
                            return (propA - propB) * (desc ? -1 : 1);
                        } else {
                            return propA.localeCompare(propB) * (desc ? -1 : 1);
                        }
                    });
                }
            }

            if (query.offset) {
                responseData = responseData.slice(Number(query.offset) || 0);
            }
            const pageSize = Number(query.pageSize) || 10;
            if (query.pageSize) {
                responseData = responseData.slice(0, pageSize);
            }

            if (query.distinct) {
                const props = query.distinct.split(',').filter(p => p != '');
                responseData = Object.values(responseData.reduce((distinct, c) => {
                    const key = props.map(p => c[p]).join('::');
                    if (distinct.hasOwnProperty(key) == false) {
                        distinct[key] = c;
                    }
                    return distinct;
                }, {}));
            }

            if (query.count) {
                return responseData.length;
            }

            if (query.select) {
                const props = query.select.split(',').filter(p => p != '');
                responseData = Array.isArray(responseData) ? responseData.map(transform) : transform(responseData);

                function transform(r) {
                    const result = {};
                    props.forEach(p => result[p] = r[p]);
                    return result;
                }
            }

            if (query.load) {
                const props = query.load.split(',').filter(p => p != '');
                props.map(prop => {
                    const [propName, relationTokens] = prop.split('=');
                    const [idSource, collection] = relationTokens.split(':');
                    console.log(`Loading related records from "${collection}" into "${propName}", joined on "_id"="${idSource}"`);
                    const storageSource = collection == 'users' ? context.protectedStorage : context.storage;
                    responseData = Array.isArray(responseData) ? responseData.map(transform) : transform(responseData);

                    function transform(r) {
                        const seekId = r[idSource];
                        const related = storageSource.get(collection, seekId);
                        delete related.hashedPassword;
                        r[propName] = related;
                        return r;
                    }
                });
            }

        } catch (err) {
            console.error(err);
            if (err.message.includes('does not exist')) {
                throw new NotFoundError$1();
            } else {
                throw new RequestError$1(err.message);
            }
        }

        context.canAccess(responseData);

        return responseData;
    }

    function post(context, tokens, query, body) {
        console.log('Request body:\n', body);

        validateRequest(context, tokens);
        if (tokens.length > 0) {
            throw new RequestError$1('Use PUT to update records');
        }
        context.canAccess(undefined, body);

        body._ownerId = context.user._id;
        let responseData;

        try {
            responseData = context.storage.add(context.params.collection, body);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }

    function put(context, tokens, query, body) {
        console.log('Request body:\n', body);

        validateRequest(context, tokens);
        if (tokens.length != 1) {
            throw new RequestError$1('Missing entry ID');
        }

        let responseData;
        let existing;

        try {
            existing = context.storage.get(context.params.collection, tokens[0]);
        } catch (err) {
            throw new NotFoundError$1();
        }

        context.canAccess(existing, body);

        try {
            responseData = context.storage.set(context.params.collection, tokens[0], body);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }

    function patch(context, tokens, query, body) {
        console.log('Request body:\n', body);

        validateRequest(context, tokens);
        if (tokens.length != 1) {
            throw new RequestError$1('Missing entry ID');
        }

        let responseData;
        let existing;

        try {
            existing = context.storage.get(context.params.collection, tokens[0]);
        } catch (err) {
            throw new NotFoundError$1();
        }

        context.canAccess(existing, body);

        try {
            responseData = context.storage.merge(context.params.collection, tokens[0], body);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }

    function del(context, tokens, query, body) {
        validateRequest(context, tokens);
        if (tokens.length != 1) {
            throw new RequestError$1('Missing entry ID');
        }

        let responseData;
        let existing;

        try {
            existing = context.storage.get(context.params.collection, tokens[0]);
        } catch (err) {
            throw new NotFoundError$1();
        }

        context.canAccess(existing);

        try {
            responseData = context.storage.delete(context.params.collection, tokens[0]);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }

    /*
     * This service requires storage and auth plugins
     */

    const dataService$1 = new Service_1();
    dataService$1.get(':collection', crud.get);
    dataService$1.post(':collection', crud.post);
    dataService$1.put(':collection', crud.put);
    dataService$1.patch(':collection', crud.patch);
    dataService$1.delete(':collection', crud.delete);

    var data$1 = dataService$1.parseRequest;

    const imgdata = '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Td4DLneAwSddMiRH8tMU8nng/Yy+KQsM3AKBNbe35j5OH4A0dbV8AxwcAqMFyl73eHd3e2//nmn29wOGi3Kv+RixSgAAEkxpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+Cjx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IlhNUCBDb3JlIDQuNC4wLUV4aXYyIj4KIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIKICAgIHhtbG5zOmlwdGNFeHQ9Imh0dHA6Ly9pcHRjLm9yZy9zdGQvSXB0YzR4bXBFeHQvMjAwOC0wMi0yOS8iCiAgICB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIKICAgIHhtbG5zOnN0RXZ0PSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VFdmVudCMiCiAgICB4bWxuczpwbHVzPSJodHRwOi8vbnMudXNlcGx1cy5vcmcvbGRmL3htcC8xLjAvIgogICAgeG1sbnM6R0lNUD0iaHR0cDovL3d3dy5naW1wLm9yZy94bXAvIgogICAgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIgogICAgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIgogICAgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIgogICAgeG1sbnM6eG1wUmlnaHRzPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvcmlnaHRzLyIKICAgeG1wTU06RG9jdW1lbnRJRD0iZ2ltcDpkb2NpZDpnaW1wOjdjZDM3NWM3LTcwNmItNDlkMy1hOWRkLWNmM2Q3MmMwY2I4ZCIKICAgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo2NGY2YTJlYy04ZjA5LTRkZTMtOTY3ZC05MTUyY2U5NjYxNTAiCiAgIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDoxMmE1NzI5Mi1kNmJkLTRlYjQtOGUxNi1hODEzYjMwZjU0NWYiCiAgIEdJTVA6QVBJPSIyLjAiCiAgIEdJTVA6UGxhdGZvcm09IldpbmRvd3MiCiAgIEdJTVA6VGltZVN0YW1wPSIxNjEzMzAwNzI5NTMwNjQzIgogICBHSU1QOlZlcnNpb249IjIuMTAuMTIiCiAgIGRjOkZvcm1hdD0iaW1hZ2UvcG5nIgogICBwaG90b3Nob3A6Q3JlZGl0PSJHZXR0eSBJbWFnZXMvaVN0b2NrcGhvdG8iCiAgIHhtcDpDcmVhdG9yVG9vbD0iR0lNUCAyLjEwIgogICB4bXBSaWdodHM6V2ViU3RhdGVtZW50PSJodHRwczovL3d3dy5pc3RvY2twaG90by5jb20vbGVnYWwvbGljZW5zZS1hZ3JlZW1lbnQ/dXRtX21lZGl1bT1vcmdhbmljJmFtcDt1dG1fc291cmNlPWdvb2dsZSZhbXA7dXRtX2NhbXBhaWduPWlwdGN1cmwiPgogICA8aXB0Y0V4dDpMb2NhdGlvbkNyZWF0ZWQ+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpMb2NhdGlvbkNyZWF0ZWQ+CiAgIDxpcHRjRXh0OkxvY2F0aW9uU2hvd24+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpMb2NhdGlvblNob3duPgogICA8aXB0Y0V4dDpBcnR3b3JrT3JPYmplY3Q+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpBcnR3b3JrT3JPYmplY3Q+CiAgIDxpcHRjRXh0OlJlZ2lzdHJ5SWQ+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpSZWdpc3RyeUlkPgogICA8eG1wTU06SGlzdG9yeT4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgc3RFdnQ6YWN0aW9uPSJzYXZlZCIKICAgICAgc3RFdnQ6Y2hhbmdlZD0iLyIKICAgICAgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDpjOTQ2M2MxMC05OWE4LTQ1NDQtYmRlOS1mNzY0ZjdhODJlZDkiCiAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkdpbXAgMi4xMCAoV2luZG93cykiCiAgICAgIHN0RXZ0OndoZW49IjIwMjEtMDItMTRUMTM6MDU6MjkiLz4KICAgIDwvcmRmOlNlcT4KICAgPC94bXBNTTpIaXN0b3J5PgogICA8cGx1czpJbWFnZVN1cHBsaWVyPgogICAgPHJkZjpTZXEvPgogICA8L3BsdXM6SW1hZ2VTdXBwbGllcj4KICAgPHBsdXM6SW1hZ2VDcmVhdG9yPgogICAgPHJkZjpTZXEvPgogICA8L3BsdXM6SW1hZ2VDcmVhdG9yPgogICA8cGx1czpDb3B5cmlnaHRPd25lcj4KICAgIDxyZGY6U2VxLz4KICAgPC9wbHVzOkNvcHlyaWdodE93bmVyPgogICA8cGx1czpMaWNlbnNvcj4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgcGx1czpMaWNlbnNvclVSTD0iaHR0cHM6Ly93d3cuaXN0b2NrcGhvdG8uY29tL3Bob3RvL2xpY2Vuc2UtZ20xMTUwMzQ1MzQxLT91dG1fbWVkaXVtPW9yZ2FuaWMmYW1wO3V0bV9zb3VyY2U9Z29vZ2xlJmFtcDt1dG1fY2FtcGFpZ249aXB0Y3VybCIvPgogICAgPC9yZGY6U2VxPgogICA8L3BsdXM6TGljZW5zb3I+CiAgIDxkYzpjcmVhdG9yPgogICAgPHJkZjpTZXE+CiAgICAgPHJkZjpsaT5WbGFkeXNsYXYgU2VyZWRhPC9yZGY6bGk+CiAgICA8L3JkZjpTZXE+CiAgIDwvZGM6Y3JlYXRvcj4KICAgPGRjOmRlc2NyaXB0aW9uPgogICAgPHJkZjpBbHQ+CiAgICAgPHJkZjpsaSB4bWw6bGFuZz0ieC1kZWZhdWx0Ij5TZXJ2aWNlIHRvb2xzIGljb24gb24gd2hpdGUgYmFja2dyb3VuZC4gVmVjdG9yIGlsbHVzdHJhdGlvbi48L3JkZjpsaT4KICAgIDwvcmRmOkFsdD4KICAgPC9kYzpkZXNjcmlwdGlvbj4KICA8L3JkZjpEZXNjcmlwdGlvbj4KIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAKPD94cGFja2V0IGVuZD0idyI/PmWJCnkAAAAGYktHRAD/AP8A/6C9p5MAAAAJcEhZcwAALiMAAC4jAXilP3YAAAAHdElNRQflAg4LBR0CZnO/AAAARHRFWHRDb21tZW50AFNlcnZpY2UgdG9vbHMgaWNvbiBvbiB3aGl0ZSBiYWNrZ3JvdW5kLiBWZWN0b3IgaWxsdXN0cmF0aW9uLlwvEeIAAAMxSURBVHja7Z1bcuQwCEX7qrLQXlp2ynxNVWbK7dgWj3sl9JvYRhxACD369erW7UMzx/cYaychonAQvXM5ABYkpynoYIiEGdoQog6AYfywBrCxF4zNrX/7McBbuXJe8rXx/KBDULcGsMREzCbeZ4J6ME/9wVH5d95rogZp3npEgPLP3m2iUSGqXBJS5Dr6hmLm8kRuZABYti5TMaailV8LodNQwTTUWk4/WZk75l0kM0aZQdaZjMqkrQDAuyMVJWFjMB4GANXr0lbZBxQKr7IjI7QvVWkok/Jn5UHVh61CYPs+/i7eL9j3y/Au8WqoAIC34k8/9k7N8miLcaGWHwgjZXE/awyYX7h41wKMCskZM2HXAddDkTdglpSjz5bcKPbcCEKwT3+DhxtVpJvkEC7rZSgq32NMSBoXaCdiahDCKrND0fpX8oQlVsQ8IFQZ1VARdIF5wroekAjB07gsAgDUIbQHFENIDEX4CQANIVe8Iw/ASiACLXl28eaf579OPuBa9/mrELUYHQ1t3KHlZZnRcXb2/c7ygXIQZqjDMEzeSrOgCAhqYMvTUE+FKXoVxTxgk3DEPREjGzj3nAk/VaKyB9GVIu4oMyOlrQZgrBBEFG9PAZTfs3amYDGrP9Wl964IeFvtz9JFluIvlEvcdoXDOdxggbDxGwTXcxFRi/LdirKgZUBm7SUdJG69IwSUzAMWgOAq/4hyrZVaJISSNWHFVbEoCFEhyBrCtXS9L+so9oTy8wGqxbQDD350WTjNESVFEB5hdKzUGcV5QtYxVWR2Ssl4Mg9qI9u6FCBInJRXgfEEgtS9Cgrg7kKouq4mdcDNBnEHQvWFTdgdgsqP+MiluVeBM13ahx09AYSWi50gsF+I6vn7BmCEoHR3NBzkpIOw4+XdVBBGQUioblaZHbGlodtB+N/jxqwLX/x/NARfD8ADxTOCKIcwE4Lw0OIbguMYcGTlymEpHYLXIKx8zQEqIfS2lGJPaADFEBR/PMH79ErqtpnZmTBlvM4wgihPWDEEhXn1LISj50crNgfCp+dWHYQRCfb2zgfnBZmKGAyi914anK9Coi4LOMhoAn3uVtn+AGnLKxPUZnCuAAAAAElFTkSuQmCC';
    const img = Buffer.from(imgdata, 'base64');

    var favicon = (method, tokens, query, body) => {
        console.log('serving favicon...');
        const headers = {
            'Content-Type': 'image/png',
            'Content-Length': img.length
        };
        let result = img;

        return {
            headers,
            result
        };
    };

    var require$$0 = "<!DOCTYPE html>\r\n<html lang=\"en\">\r\n<head>\r\n    <meta charset=\"UTF-8\">\r\n    <meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\">\r\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\r\n    <title>SUPS Admin Panel</title>\r\n    <style>\r\n        * {\r\n            padding: 0;\r\n            margin: 0;\r\n        }\r\n\r\n        body {\r\n            padding: 32px;\r\n            font-size: 16px;\r\n        }\r\n\r\n        .layout::after {\r\n            content: '';\r\n            clear: both;\r\n            display: table;\r\n        }\r\n\r\n        .col {\r\n            display: block;\r\n            float: left;\r\n        }\r\n\r\n        p {\r\n            padding: 8px 16px;\r\n        }\r\n\r\n        table {\r\n            border-collapse: collapse;\r\n        }\r\n\r\n        caption {\r\n            font-size: 120%;\r\n            text-align: left;\r\n            padding: 4px 8px;\r\n            font-weight: bold;\r\n            background-color: #ddd;\r\n        }\r\n\r\n        table, tr, th, td {\r\n            border: 1px solid #ddd;\r\n        }\r\n\r\n        th, td {\r\n            padding: 4px 8px;\r\n        }\r\n\r\n        ul {\r\n            list-style: none;\r\n        }\r\n\r\n        .collection-list a {\r\n            display: block;\r\n            width: 120px;\r\n            padding: 4px 8px;\r\n            text-decoration: none;\r\n            color: black;\r\n            background-color: #ccc;\r\n        }\r\n        .collection-list a:hover {\r\n            background-color: #ddd;\r\n        }\r\n        .collection-list a:visited {\r\n            color: black;\r\n        }\r\n    </style>\r\n    <script type=\"module\">\nimport { html, render } from 'https://unpkg.com/lit-html?module';\nimport { until } from 'https://unpkg.com/lit-html/directives/until?module';\n\nconst api = {\r\n    async get(url) {\r\n        return json(url);\r\n    },\r\n    async post(url, body) {\r\n        return json(url, {\r\n            method: 'POST',\r\n            headers: { 'Content-Type': 'application/json' },\r\n            body: JSON.stringify(body)\r\n        });\r\n    }\r\n};\r\n\r\nasync function json(url, options) {\r\n    return await (await fetch('/' + url, options)).json();\r\n}\r\n\r\nasync function getCollections() {\r\n    return api.get('data');\r\n}\r\n\r\nasync function getRecords(collection) {\r\n    return api.get('data/' + collection);\r\n}\r\n\r\nasync function getThrottling() {\r\n    return api.get('util/throttle');\r\n}\r\n\r\nasync function setThrottling(throttle) {\r\n    return api.post('util', { throttle });\r\n}\n\nasync function collectionList(onSelect) {\r\n    const collections = await getCollections();\r\n\r\n    return html`\r\n    <ul class=\"collection-list\">\r\n        ${collections.map(collectionLi)}\r\n    </ul>`;\r\n\r\n    function collectionLi(name) {\r\n        return html`<li><a href=\"javascript:void(0)\" @click=${(ev) => onSelect(ev, name)}>${name}</a></li>`;\r\n    }\r\n}\n\nasync function recordTable(collectionName) {\r\n    const records = await getRecords(collectionName);\r\n    const layout = getLayout(records);\r\n\r\n    return html`\r\n    <table>\r\n        <caption>${collectionName}</caption>\r\n        <thead>\r\n            <tr>${layout.map(f => html`<th>${f}</th>`)}</tr>\r\n        </thead>\r\n        <tbody>\r\n            ${records.map(r => recordRow(r, layout))}\r\n        </tbody>\r\n    </table>`;\r\n}\r\n\r\nfunction getLayout(records) {\r\n    const result = new Set(['_id']);\r\n    records.forEach(r => Object.keys(r).forEach(k => result.add(k)));\r\n\r\n    return [...result.keys()];\r\n}\r\n\r\nfunction recordRow(record, layout) {\r\n    return html`\r\n    <tr>\r\n        ${layout.map(f => html`<td>${JSON.stringify(record[f]) || html`<span>(missing)</span>`}</td>`)}\r\n    </tr>`;\r\n}\n\nasync function throttlePanel(display) {\r\n    const active = await getThrottling();\r\n\r\n    return html`\r\n    <p>\r\n        Request throttling: </span>${active}</span>\r\n        <button @click=${(ev) => set(ev, true)}>Enable</button>\r\n        <button @click=${(ev) => set(ev, false)}>Disable</button>\r\n    </p>`;\r\n\r\n    async function set(ev, state) {\r\n        ev.target.disabled = true;\r\n        await setThrottling(state);\r\n        display();\r\n    }\r\n}\n\n//import page from '//unpkg.com/page/page.mjs';\r\n\r\n\r\nfunction start() {\r\n    const main = document.querySelector('main');\r\n    editor(main);\r\n}\r\n\r\nasync function editor(main) {\r\n    let list = html`<div class=\"col\">Loading&hellip;</div>`;\r\n    let viewer = html`<div class=\"col\">\r\n    <p>Select collection to view records</p>\r\n</div>`;\r\n    display();\r\n\r\n    list = html`<div class=\"col\">${await collectionList(onSelect)}</div>`;\r\n    display();\r\n\r\n    async function display() {\r\n        render(html`\r\n        <section class=\"layout\">\r\n            ${until(throttlePanel(display), html`<p>Loading</p>`)}\r\n        </section>\r\n        <section class=\"layout\">\r\n            ${list}\r\n            ${viewer}\r\n        </section>`, main);\r\n    }\r\n\r\n    async function onSelect(ev, name) {\r\n        ev.preventDefault();\r\n        viewer = html`<div class=\"col\">${await recordTable(name)}</div>`;\r\n        display();\r\n    }\r\n}\r\n\r\nstart();\n\n</script>\r\n</head>\r\n<body>\r\n    <main>\r\n        Loading&hellip;\r\n    </main>\r\n</body>\r\n</html>";

    const mode = process.argv[2] == '-dev' ? 'dev' : 'prod';

    const files = {
        index: mode == 'prod' ? require$$0 : fs__default['default'].readFileSync('./client/index.html', 'utf-8')
    };

    var admin = (method, tokens, query, body) => {
        const headers = {
            'Content-Type': 'text/html'
        };
        let result = '';

        const resource = tokens.join('/');
        if (resource && resource.split('.').pop() == 'js') {
            headers['Content-Type'] = 'application/javascript';

            files[resource] = files[resource] || fs__default['default'].readFileSync('./client/' + resource, 'utf-8');
            result = files[resource];
        } else {
            result = files.index;
        }

        return {
            headers,
            result
        };
    };

    /*
     * This service requires util plugin
     */

    const utilService = new Service_1();

    utilService.post('*', onRequest);
    utilService.get(':service', getStatus);

    function getStatus(context, tokens, query, body) {
        return context.util[context.params.service];
    }

    function onRequest(context, tokens, query, body) {
        Object.entries(body).forEach(([k, v]) => {
            console.log(`${k} ${v ? 'enabled' : 'disabled'}`);
            context.util[k] = v;
        });
        return '';
    }

    var util$1 = utilService.parseRequest;

    var services = {
        jsonstore,
        users,
        data: data$1,
        favicon,
        admin,
        util: util$1
    };

    const { uuid: uuid$2 } = util;


    function initPlugin(settings) {
        const storage = createInstance(settings.seedData);
        const protectedStorage = createInstance(settings.protectedData);

        return function decoreateContext(context, request) {
            context.storage = storage;
            context.protectedStorage = protectedStorage;
        };
    }


    /**
     * Create storage instance and populate with seed data
     * @param {Object=} seedData Associative array with data. Each property is an object with properties in format {key: value}
     */
    function createInstance(seedData = {}) {
        const collections = new Map();

        // Initialize seed data from file    
        for (let collectionName in seedData) {
            if (seedData.hasOwnProperty(collectionName)) {
                const collection = new Map();
                for (let recordId in seedData[collectionName]) {
                    if (seedData.hasOwnProperty(collectionName)) {
                        collection.set(recordId, seedData[collectionName][recordId]);
                    }
                }
                collections.set(collectionName, collection);
            }
        }


        // Manipulation

        /**
         * Get entry by ID or list of all entries from collection or list of all collections
         * @param {string=} collection Name of collection to access. Throws error if not found. If omitted, returns list of all collections.
         * @param {number|string=} id ID of requested entry. Throws error if not found. If omitted, returns of list all entries in collection.
         * @return {Object} Matching entry.
         */
        function get(collection, id) {
            if (!collection) {
                return [...collections.keys()];
            }
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!id) {
                const entries = [...targetCollection.entries()];
                let result = entries.map(([k, v]) => {
                    return Object.assign(deepCopy(v), { _id: k });
                });
                return result;
            }
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }
            const entry = targetCollection.get(id);
            return Object.assign(deepCopy(entry), { _id: id });
        }

        /**
         * Add new entry to collection. ID will be auto-generated
         * @param {string} collection Name of collection to access. If the collection does not exist, it will be created.
         * @param {Object} data Value to store.
         * @return {Object} Original value with resulting ID under _id property.
         */
        function add(collection, data) {
            const record = assignClean({ _ownerId: data._ownerId }, data);

            let targetCollection = collections.get(collection);
            if (!targetCollection) {
                targetCollection = new Map();
                collections.set(collection, targetCollection);
            }
            let id = uuid$2();
            // Make sure new ID does not match existing value
            while (targetCollection.has(id)) {
                id = uuid$2();
            }

            record._createdOn = Date.now();
            targetCollection.set(id, record);
            return Object.assign(deepCopy(record), { _id: id });
        }

        /**
         * Replace entry by ID
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {number|string} id ID of entry to update. Throws error if not found.
         * @param {Object} data Value to store. Record will be replaced!
         * @return {Object} Updated entry.
         */
        function set(collection, id, data) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }

            const existing = targetCollection.get(id);
            const record = assignSystemProps(deepCopy(data), existing);
            record._updatedOn = Date.now();
            targetCollection.set(id, record);
            return Object.assign(deepCopy(record), { _id: id });
        }

        /**
         * Modify entry by ID
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {number|string} id ID of entry to update. Throws error if not found.
         * @param {Object} data Value to store. Shallow merge will be performed!
         * @return {Object} Updated entry.
         */
        function merge(collection, id, data) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }

            const existing = deepCopy(targetCollection.get(id));
            const record = assignClean(existing, data);
            record._updatedOn = Date.now();
            targetCollection.set(id, record);
            return Object.assign(deepCopy(record), { _id: id });
        }

        /**
         * Delete entry by ID
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {number|string} id ID of entry to update. Throws error if not found.
         * @return {{_deletedOn: number}} Server time of deletion.
         */
        function del(collection, id) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }
            targetCollection.delete(id);

            return { _deletedOn: Date.now() };
        }

        /**
         * Search in collection by query object
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {Object} query Query object. Format {prop: value}.
         * @return {Object[]} Array of matching entries.
         */
        function query(collection, query) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            const result = [];
            // Iterate entries of target collection and compare each property with the given query
            for (let [key, entry] of [...targetCollection.entries()]) {
                let match = true;
                for (let prop in entry) {
                    if (query.hasOwnProperty(prop)) {
                        const targetValue = query[prop];
                        // Perform lowercase search, if value is string
                        if (typeof targetValue === 'string' && typeof entry[prop] === 'string') {
                            if (targetValue.toLocaleLowerCase() !== entry[prop].toLocaleLowerCase()) {
                                match = false;
                                break;
                            }
                        } else if (targetValue != entry[prop]) {
                            match = false;
                            break;
                        }
                    }
                }

                if (match) {
                    result.push(Object.assign(deepCopy(entry), { _id: key }));
                }
            }

            return result;
        }

        return { get, add, set, merge, delete: del, query };
    }


    function assignSystemProps(target, entry, ...rest) {
        const whitelist = [
            '_id',
            '_createdOn',
            '_updatedOn',
            '_ownerId'
        ];
        for (let prop of whitelist) {
            if (entry.hasOwnProperty(prop)) {
                target[prop] = deepCopy(entry[prop]);
            }
        }
        if (rest.length > 0) {
            Object.assign(target, ...rest);
        }

        return target;
    }


    function assignClean(target, entry, ...rest) {
        const blacklist = [
            '_id',
            '_createdOn',
            '_updatedOn',
            '_ownerId'
        ];
        for (let key in entry) {
            if (blacklist.includes(key) == false) {
                target[key] = deepCopy(entry[key]);
            }
        }
        if (rest.length > 0) {
            Object.assign(target, ...rest);
        }

        return target;
    }

    function deepCopy(value) {
        if (Array.isArray(value)) {
            return value.map(deepCopy);
        } else if (typeof value == 'object') {
            return [...Object.entries(value)].reduce((p, [k, v]) => Object.assign(p, { [k]: deepCopy(v) }), {});
        } else {
            return value;
        }
    }

    var storage = initPlugin;

    const { ConflictError: ConflictError$1, CredentialError: CredentialError$1, RequestError: RequestError$2 } = errors;

    function initPlugin$1(settings) {
        const identity = settings.identity;

        return function decorateContext(context, request) {
            context.auth = {
                register,
                login,
                logout
            };

            const userToken = request.headers['x-authorization'];
            if (userToken !== undefined) {
                let user;
                const session = findSessionByToken(userToken);
                if (session !== undefined) {
                    const userData = context.protectedStorage.get('users', session.userId);
                    if (userData !== undefined) {
                        console.log('Authorized as ' + userData[identity]);
                        user = userData;
                    }
                }
                if (user !== undefined) {
                    context.user = user;
                } else {
                    throw new CredentialError$1('Invalid access token');
                }
            }

            function register(body) {
                if (body.hasOwnProperty(identity) === false ||
                    body.hasOwnProperty('password') === false ||
                    body[identity].length == 0 ||
                    body.password.length == 0) {
                    throw new RequestError$2('Missing fields');
                } else if (context.protectedStorage.query('users', { [identity]: body[identity] }).length !== 0) {
                    throw new ConflictError$1(`A user with the same ${identity} already exists`);
                } else {
                    const newUser = Object.assign({}, body, {
                        [identity]: body[identity],
                        hashedPassword: hash(body.password)
                    });
                    const result = context.protectedStorage.add('users', newUser);
                    delete result.hashedPassword;

                    const session = saveSession(result._id);
                    result.accessToken = session.accessToken;

                    return result;
                }
            }

            function login(body) {
                const targetUser = context.protectedStorage.query('users', { [identity]: body[identity] });
                if (targetUser.length == 1) {
                    if (hash(body.password) === targetUser[0].hashedPassword) {
                        const result = targetUser[0];
                        delete result.hashedPassword;

                        const session = saveSession(result._id);
                        result.accessToken = session.accessToken;

                        return result;
                    } else {
                        throw new CredentialError$1('Login or password don\'t match');
                    }
                } else {
                    throw new CredentialError$1('Login or password don\'t match');
                }
            }

            function logout() {
                if (context.user !== undefined) {
                    const session = findSessionByUserId(context.user._id);
                    if (session !== undefined) {
                        context.protectedStorage.delete('sessions', session._id);
                    }
                } else {
                    throw new CredentialError$1('User session does not exist');
                }
            }

            function saveSession(userId) {
                let session = context.protectedStorage.add('sessions', { userId });
                const accessToken = hash(session._id);
                session = context.protectedStorage.set('sessions', session._id, Object.assign({ accessToken }, session));
                return session;
            }

            function findSessionByToken(userToken) {
                return context.protectedStorage.query('sessions', { accessToken: userToken })[0];
            }

            function findSessionByUserId(userId) {
                return context.protectedStorage.query('sessions', { userId })[0];
            }
        };
    }


    const secret = 'This is not a production server';

    function hash(string) {
        const hash = crypto__default['default'].createHmac('sha256', secret);
        hash.update(string);
        return hash.digest('hex');
    }

    var auth = initPlugin$1;

    function initPlugin$2(settings) {
        const util = {
            throttle: false
        };

        return function decoreateContext(context, request) {
            context.util = util;
        };
    }

    var util$2 = initPlugin$2;

    /*
     * This plugin requires auth and storage plugins
     */

    const { RequestError: RequestError$3, ConflictError: ConflictError$2, CredentialError: CredentialError$2, AuthorizationError: AuthorizationError$2 } = errors;

    function initPlugin$3(settings) {
        const actions = {
            'GET': '.read',
            'POST': '.create',
            'PUT': '.update',
            'PATCH': '.update',
            'DELETE': '.delete'
        };
        const rules = Object.assign({
            '*': {
                '.create': ['User'],
                '.update': ['User'],
                '.delete': ['User']
            }
        }, settings.rules);

        return function decorateContext(context, request) {
            // special rules (evaluated at run-time)
            const get = (collectionName, id) => {
                return context.storage.get(collectionName, id);
            };
            const isOwner = (user, object) => {
                return user._id == object._ownerId;
            };
            context.rules = {
                get,
                isOwner
            };
            const isAdmin = request.headers.hasOwnProperty('x-admin');

            context.canAccess = canAccess;

            function canAccess(data, newData) {
                const user = context.user;
                const action = actions[request.method];
                let { rule, propRules } = getRule(action, context.params.collection, data);

                if (Array.isArray(rule)) {
                    rule = checkRoles(rule, data);
                } else if (typeof rule == 'string') {
                    rule = !!(eval(rule));
                }
                if (!rule && !isAdmin) {
                    throw new CredentialError$2();
                }
                propRules.map(r => applyPropRule(action, r, user, data, newData));
            }

            function applyPropRule(action, [prop, rule], user, data, newData) {
                // NOTE: user needs to be in scope for eval to work on certain rules
                if (typeof rule == 'string') {
                    rule = !!eval(rule);
                }

                if (rule == false) {
                    if (action == '.create' || action == '.update') {
                        delete newData[prop];
                    } else if (action == '.read') {
                        delete data[prop];
                    }
                }
            }

            function checkRoles(roles, data, newData) {
                if (roles.includes('Guest')) {
                    return true;
                } else if (!context.user && !isAdmin) {
                    throw new AuthorizationError$2();
                } else if (roles.includes('User')) {
                    return true;
                } else if (context.user && roles.includes('Owner')) {
                    return context.user._id == data._ownerId;
                } else {
                    return false;
                }
            }
        };



        function getRule(action, collection, data = {}) {
            let currentRule = ruleOrDefault(true, rules['*'][action]);
            let propRules = [];

            // Top-level rules for the collection
            const collectionRules = rules[collection];
            if (collectionRules !== undefined) {
                // Top-level rule for the specific action for the collection
                currentRule = ruleOrDefault(currentRule, collectionRules[action]);

                // Prop rules
                const allPropRules = collectionRules['*'];
                if (allPropRules !== undefined) {
                    propRules = ruleOrDefault(propRules, getPropRule(allPropRules, action));
                }

                // Rules by record id 
                const recordRules = collectionRules[data._id];
                if (recordRules !== undefined) {
                    currentRule = ruleOrDefault(currentRule, recordRules[action]);
                    propRules = ruleOrDefault(propRules, getPropRule(recordRules, action));
                }
            }

            return {
                rule: currentRule,
                propRules
            };
        }

        function ruleOrDefault(current, rule) {
            return (rule === undefined || rule.length === 0) ? current : rule;
        }

        function getPropRule(record, action) {
            const props = Object
                .entries(record)
                .filter(([k]) => k[0] != '.')
                .filter(([k, v]) => v.hasOwnProperty(action))
                .map(([k, v]) => [k, v[action]]);

            return props;
        }
    }

    var rules = initPlugin$3;

    var identity = "username";
    var protectedData = {
        users: {
            "35c62d76-8152-4626-8712-eeb96381bea8": {
                fullname: "Peter Petrov",
                username: "Peter",
                hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
                "_createdOn": 1679578258049
            },
            "847ec027-f659-4086-8032-5173e2f9c93a": {
                fullname: "John Johnes",
                username: "John",
                hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
                "_createdOn": 1679578258029
            },
            "847ec027-f659-4086-8032-5173e2f9c93b": {
                fullname: "Ivan Ivanov",
                username: "Ivan",
                hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
                "_createdOn": 1679578258019
            },
            "35c62d76-8152-4626-8712-eeb96381bea1": {
                fullname: "Todor Petrov",
                username: "Todor",
                hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
                "_createdOn": 1679568258049
            },
            "35c62d76-8152-4626-8712-eeb96381bea2": {
                fullname: "Peter Todorov",
                username: "Pesho",
                hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
                "_createdOn": 1679577258049
            },
            "35c62d76-8152-4626-8712-eeb96381bea3": {
                fullname: "Stanislav Hrusanov",
                username: "Stan",
                hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
                "_createdOn": 1679579258049
            }
        },
        sessions: {
        }
    };
    var seedData = {
        restaurants: {
            "ff436770-76c5-40e2-b231-77409eda7a61": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "name": "Viaturna Melnica",
                "address": "12, Morski skali, Sozopol 8130",
                "phone": "+359888888888",
                "capacity": 300,
                "imageUrl": "https://fastly.4sqi.net/img/general/600x600/32551704_l_uL8IULNtcByxgmcCtPPtZQL4_swnvqekBtyLN7XIE.jpg",
                "summary": "Viaturna melnica is located in old town of Sozopol. It offers traditional Bulgarian food of it's guests.",
                "reviews": [
                    {
                        "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                        "restaurantId": "ff436770-76c5-40e2-b231-77409eda7a61",
                        "restaurantName": "Viaturna Melnica",
                        "author": "Ivan",
                        "rating": 5,
                        "comment": "Perfect meals! I love it!",
                        "_createdOn": 1680525605810,
                        "_id": "742ae8ac-0c42-4cb9-b030-0bfd4a1e4253"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                        "restaurantId": "ff436770-76c5-40e2-b231-77409eda7a61",
                        "restaurantName": "Viaturna Melnica",
                        "author": "Todor",
                        "rating": 4,
                        "comment": "Delicious food, but a little noisy!",
                        "_createdOn": 1680526683143,
                        "_id": "78f2f679-16a3-470c-bd64-6bd6da39cca6"
                    }
                ],
                "_createdOn": 1617194128618,
                "_id": "ff436770-76c5-40e2-b231-77409eda7a61",
                "_updatedOn": 1680526683183
            },
            "1840a313-225c-416a-817a-9954d4609f7c": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "name": "Pri hudojnicite",
                "address": "80, Kiril i Metodii, Sozopol 8130",
                "phone": "+359888888888",
                "capacity": 150,
                "imageUrl": "https://www.arthotel-sbh.com/wp-content/uploads/2021/12/Ev.Hud-27-1200x812.jpg",
                "summary": "Restaurant Pri hudojnicite is located in old town of Sozopol. It offers fresh fish and other sea foods.",
                "reviews": [
                    {
                        "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
                        "restaurantId": "1840a313-225c-416a-817a-9954d4609f7c",
                        "restaurantName": "Pri hudojnicite",
                        "rating": 3,
                        "author": "John",
                        "comment": "Good!",
                        "_createdOn": 1678708464033,
                        "_id": "8d7fa12f-3669-453b-adc6-550d6295f6c4"
                    },
                    {
                        "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                        "restaurantId": "1840a313-225c-416a-817a-9954d4609f7c",
                        "restaurantName": "Pri hudojnicite",
                        "author": "Ivan",
                        "rating": 4,
                        "comment": "The view from terrace was very beautiful! Тhe service was not up to par!",
                        "_createdOn": 1680525962845,
                        "_id": "cfa2c0ed-a420-436f-b80a-b24ad3b6d9de"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                        "restaurantId": "1840a313-225c-416a-817a-9954d4609f7c",
                        "restaurantName": "Pri hudojnicite",
                        "author": "Pesho",
                        "rating": 1,
                        "comment": "The food (mussels, meat) wasn’t good, salads are crap, 1 sweet waitress is handling all the tables and things are happening very slow",
                        "_createdOn": 1680528125566,
                        "_id": "5bdc79d5-4f14-44db-ba64-2d8d49585266"
                    }
                ],
                "_createdOn": 1617194210928,
                "_id": "1840a313-225c-416a-817a-9954d4609f7c",
                "_updatedOn": 1680528125589
            },
            "126777f5-3277-42ad-b874-76d043b069cb": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
                "name": "Boca Grande",
                "address": "15, Kraibrejna, Sozopol 8130",
                "phone": "+359888888888",
                "capacity": 200,
                "imageUrl": "https://gradat.bg/sites/default/files/styles/page_article_dynamic_width/public/mainimages/o_3045804_0.jpg?itok=Te1DzaI8",
                "summary": "A first-class drink with friends or a blissful meal in your own company are some of the options our restaurants proudly serve. A meal at the Boca Grande restaurant will transport you to Spain without leaving dazzling Sozopol.",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                        "restaurantId": "126777f5-3277-42ad-b874-76d043b069cb",
                        "restaurantName": "Boca Grande",
                        "rating": 5,
                        "author": "Peter",
                        "comment": "Excellent!",
                        "_createdOn": 1678708464033,
                        "_id": "8d7fa12f-3669-453b-adc6-550d6295f6c2"
                    },
                    {
                        "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                        "restaurantId": "126777f5-3277-42ad-b874-76d043b069cb",
                        "restaurantName": "Boca Grande",
                        "author": "Ivan",
                        "rating": 5,
                        "comment": "Great meals! Luxury design!",
                        "_createdOn": 1680525695853,
                        "_id": "81b2ec07-bb85-45b7-908d-c41faae5c090"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                        "restaurantId": "126777f5-3277-42ad-b874-76d043b069cb",
                        "restaurantName": "Boca Grande",
                        "author": "Todor",
                        "rating": 3,
                        "comment": "Good, but a little expensive!",
                        "_createdOn": 1680526799006,
                        "_id": "ef86da0c-4bdf-455e-a091-fa2af5ebf5c5"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                        "restaurantId": "126777f5-3277-42ad-b874-76d043b069cb",
                        "restaurantName": "Boca Grande",
                        "author": "Pesho",
                        "rating": 5,
                        "comment": "We were very satisfied with the food, drinks and the services! The waiter was very polite and tended to our table whenever we needed something.The view is also spectacular. Highly recommended!",
                        "_createdOn": 1680527998205,
                        "_id": "e250b3a1-656a-4d9b-857a-da3fac71e570"
                    }
                ],
                "_createdOn": 1617194295474,
                "_id": "126777f5-3277-42ad-b874-76d043b069cb",
                "_updatedOn": 1680527998230
            },
            "126777f5-3277-42ad-b874-76d043b069cd": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
                "name": "Coral",
                "address": "15, Yani Hrisopolu, Sozopol 8130",
                "phone": "+359888888888",
                "capacity": 50,
                "imageUrl": "https://guest-house-koral-sozopol.hotelmix.bg/data/Photos/OriginalPhoto/1431/143152/143152287/Guest-House-Koral-Sozopol-Exterior.JPEG",
                "summary": "A small family restaurant located in old town of Sozopol. It is a quiet place with delicious traditional and sea food.",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                        "restaurantId": "126777f5-3277-42ad-b874-76d043b069cd",
                        "restaurantName": "Coral",
                        "rating": 4,
                        "author": "Peter",
                        "comment": "Very good!",
                        "_createdOn": 1678708464073,
                        "_id": "8d7fa12f-3669-453b-adc6-550d6295f6c3"
                    },
                    {
                        "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                        "restaurantId": "126777f5-3277-42ad-b874-76d043b069cd",
                        "restaurantName": "Coral",
                        "rating": 5,
                        "author": "Ivan",
                        "comment": "Nice place!",
                        "_createdOn": 1678707454013,
                        "_id": "8d7fa12f-3669-453b-adc6-550d6295f6c8"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                        "restaurantId": "126777f5-3277-42ad-b874-76d043b069cd",
                        "restaurantName": "Coral",
                        "author": "Todor",
                        "rating": 5,
                        "comment": "Small family restaurant! I love it! The service was perfect!",
                        "_createdOn": 1680526747168,
                        "_id": "56838567-e961-431b-8dfb-16924e8a8f42"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                        "restaurantId": "126777f5-3277-42ad-b874-76d043b069cd",
                        "restaurantName": "Coral",
                        "author": "Pesho",
                        "rating": 5,
                        "comment": "Food was excellent! And the staff was very responsive and friendly. It is very busy at night, so I recommend to book a table in advance. The salads with rose tomato, the tuna tartar and the sea tongue are a must!",
                        "_createdOn": 1680528047738,
                        "_id": "239e78bf-8e05-44db-9b95-64a21a13fe6f"
                    },
                    {
                        "_ownerId": "085224ee-a2fb-4af6-8b02-a68d35f487b3",
                        "restaurantId": "126777f5-3277-42ad-b874-76d043b069cd",
                        "restaurantName": "Coral",
                        "author": "Elizabeth",
                        "rating": 5,
                        "comment": "Nice small restaurant",
                        "_createdOn": 1680530550460,
                        "_id": "6bb647d1-73c1-412d-9b24-232776baf123"
                    }
                ],
                "_createdOn": 1617194295475,
                "_id": "126777f5-3277-42ad-b874-76d043b069cd",
                "_updatedOn": 1680530550491
            },
            "9fe6b7b0-040b-42df-9a9c-c4cb0bf1df85": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                "name": "Albatros",
                "address": "Yani Popov 10, Sozopol 8130 Bulgaria",
                "phone": "+359897909089",
                "capacity": "60",
                "imageUrl": "https://images.myguide-cdn.com/bulgaria/companies/albatros-sozopol/large/albatros-sozopol-163267.jpg",
                "summary": "The restaurant of Hotel Albatros -New city is a peaceful place where every connoisseur of good food will be able to enjoy a variety of seafood and fish dishes from the traditional Bulgarian cuisine and various dishes at affordable prices. The maximum capacity of the restaurant is 60 seats on two levels in the inner hall and a summer terrace.",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                        "restaurantId": "9fe6b7b0-040b-42df-9a9c-c4cb0bf1df85",
                        "restaurantName": "Albatros",
                        "author": "Todor",
                        "rating": 5,
                        "comment": "Best restaurant in Sozopol!",
                        "_createdOn": 1680526609934,
                        "_id": "c2621cc6-3ec4-43b6-a287-54119f297d25"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea3",
                        "restaurantId": "9fe6b7b0-040b-42df-9a9c-c4cb0bf1df85",
                        "restaurantName": "Albatros",
                        "author": "Stan",
                        "rating": 5,
                        "comment": "Great food, a very friendly staff, atmosphere in the restaurant is ok, nothing special but very clean. All In all, a must visit place in Sozopol.",
                        "_createdOn": 1680528885893,
                        "_id": "e38b0763-b380-4794-9266-565ed81d6fa0"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                        "restaurantId": "9fe6b7b0-040b-42df-9a9c-c4cb0bf1df85",
                        "restaurantName": "Albatros",
                        "author": "Peter",
                        "rating": 5,
                        "comment": "This is one of the best small restaurant i have ever been. The food is so tasty and the menu is perfect. The servise in hi-top level. I love it :-)",
                        "_createdOn": 1680529077319,
                        "_id": "460d561b-a138-4df2-a2a3-613e2c93263d"
                    },
                    {
                        "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
                        "restaurantId": "9fe6b7b0-040b-42df-9a9c-c4cb0bf1df85",
                        "restaurantName": "Albatros",
                        "author": "John",
                        "rating": 4,
                        "comment": "Located not in the very beach, however, it offers quite a lot of fish. They produce their own beer and this is always a plus. Interesting.",
                        "_createdOn": 1680529353473,
                        "_id": "1dbe9ca5-d557-492c-9509-80eb8ba8d95e"
                    }
                ],
                "_createdOn": 1680525078128,
                "_id": "9fe6b7b0-040b-42df-9a9c-c4cb0bf1df85",
                "_updatedOn": 1680529353494
            },
            "cab97cb0-690d-429c-baea-c10409ff7a8e": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                "name": "Black Bison Grill & Bar",
                "address": "Industrialna Str 9 8130, Sozopol 8130 Bulgaria",
                "phone": "+359123123123",
                "capacity": "20",
                "imageUrl": "https://www.teampro.bg/sites/default/files/logo_black_bizon.jpg",
                "summary": "Since 2014, our family company has maintained a tradition of high quality food on the Bulgarian market. Low price. Heavy Weigth. Great Taste. Only Natural Ingredients.",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                        "restaurantId": "cab97cb0-690d-429c-baea-c10409ff7a8e",
                        "restaurantName": "Black Bison Grill & Bar",
                        "author": "Todor",
                        "rating": 5,
                        "comment": "The chiken burgers was so delicious!",
                        "_createdOn": 1680526545411,
                        "_id": "635bfdf1-4dea-417a-8f41-2f5da7cb76d4"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                        "restaurantId": "cab97cb0-690d-429c-baea-c10409ff7a8e",
                        "restaurantName": "Black Bison Grill & Bar",
                        "author": "Peter",
                        "rating": 5,
                        "comment": "The best burger place in Sozopol. One of the most delicious onion rings I have ever tried when combined with their secret homemade sauce!",
                        "_createdOn": 1680529026363,
                        "_id": "6f18f407-9be5-442b-addc-33f26bcb7f48"
                    }
                ],
                "_createdOn": 1680525375967,
                "_id": "cab97cb0-690d-429c-baea-c10409ff7a8e",
                "_updatedOn": 1680529026453
            },
            "26e4a065-679f-47cf-94af-9ac3faeeb2da": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                "name": "Del Muro",
                "address": "Milet 42, Sozopol 8130 Bulgaria",
                "phone": "+359889012210",
                "capacity": "150",
                "imageUrl": "https://kralevgroup.com/wp-content/uploads/2020/08/delmuro-interior-6.jpg",
                "summary": "Welcome to the heart of the most beautiful part of Sozopol the South Fortress Wall! Inspired by the magic of the Italian and French cuisine we created Restaurant Del Muro in order to express our gratitude through one of the most delicate forms of expression that is food.",
                "reviews": [
                    {
                        "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                        "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                        "restaurantName": "Del Muro",
                        "author": "Ivan",
                        "rating": 5,
                        "comment": "Excellent!",
                        "_createdOn": 1680527034679,
                        "_id": "8ae13886-e095-46a6-9e27-8939df914f08"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                        "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                        "restaurantName": "Del Muro",
                        "author": "Pesho",
                        "rating": 5,
                        "comment": "Lovely restaurant, perfect for a romantic dinner. The food was very fresh and tasty and the service was very nice",
                        "_createdOn": 1680527951083,
                        "_id": "9ddd5e00-d32a-4c00-9f34-d4981ae1aaee"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea3",
                        "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                        "restaurantName": "Del Muro",
                        "author": "Stan",
                        "rating": 5,
                        "comment": "Our favorite. Great food, service, atmosphere. Easily best one in Sozopol, going steadily for years, never disappointed so far.",
                        "_createdOn": 1680528934863,
                        "_id": "9f7e690b-0478-43e8-8288-6e65d6568eef"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                        "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                        "restaurantName": "Del Muro",
                        "author": "Peter",
                        "rating": 5,
                        "comment": "Went there with my wife. Make sure to make a reservation for the terrace (first lone). Beautiful place with an amazing view. Service was great too. Very friendly and professional staff.",
                        "_createdOn": 1680529211491,
                        "_id": "40df948b-150d-456e-85fc-eafe67505d35"
                    },
                    {
                        "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
                        "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                        "restaurantName": "Del Muro",
                        "author": "John",
                        "rating": 5,
                        "comment": "Incredible place, just amazing food and service!!! Recommend it!!! The best place in Sozopol! I love it!",
                        "_createdOn": 1680529310920,
                        "_id": "0f6657c5-2cba-49aa-9266-9fc2c0dc6891"
                    },
                    {
                        "_ownerId": "085224ee-a2fb-4af6-8b02-a68d35f487b3",
                        "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                        "restaurantName": "Del Muro",
                        "author": "Elizabeth",
                        "rating": 5,
                        "comment": "Perfect place!",
                        "_createdOn": 1680530506416,
                        "_id": "18aa3411-8fb5-4d47-963a-91bf6ca217c4"
                    }
                ],
                "_createdOn": 1680526151113,
                "_id": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                "_updatedOn": 1680530506453
            },
            "b51fcde2-3514-4484-9c41-69f8cf9ab9b4": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                "name": "Veranda",
                "address": "Odesa 16, Sozopol 8130 Bulgaria",
                "phone": "+359889012210",
                "capacity": "140",
                "imageUrl": "https://www.smpm.bg//storage1/images/news/item164/View.jpg",
                "summary": "Seafood, Mediterranean, European, Eastern European, Central European",
                "reviews": [
                    {
                        "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                        "restaurantId": "b51fcde2-3514-4484-9c41-69f8cf9ab9b4",
                        "restaurantName": "Veranda",
                        "author": "Ivan",
                        "rating": 3,
                        "comment": "Good!",
                        "_createdOn": 1680527055175,
                        "_id": "08a2a090-4d6a-4232-b43e-5e40af0f2773"
                    },
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                        "restaurantId": "b51fcde2-3514-4484-9c41-69f8cf9ab9b4",
                        "restaurantName": "Veranda",
                        "author": "Pesho",
                        "rating": 4,
                        "comment": "Nice terrace place with outdoor seating. In the heart of the new town. Tasty and cheap. Very friendly staff:)",
                        "_createdOn": 1680528195013,
                        "_id": "d9ec5c30-2688-4edd-8fd3-444fa742f80b"
                    }
                ],
                "_createdOn": 1680526486264,
                "_id": "b51fcde2-3514-4484-9c41-69f8cf9ab9b4",
                "_updatedOn": 1680528195042
            },
            "81bff2c2-6c70-4729-a9e7-276530eb9282": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "name": "Panorama Sv. Ivan",
                "address": "Morski skali 21, Sozopol 8130 Bulgaria",
                "phone": "+359123123123",
                "capacity": "50",
                "imageUrl": "https://fastly.4sqi.net/img/general/600x600/62648606_xOH6nXhQpAPQnfahnutz22RNZofjcetSfXU2nxB3EXA.jpg",
                "summary": "Come and taste our fresh sea food, traditional Bulgarian foods and our homemade desserts!",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea3",
                        "restaurantId": "81bff2c2-6c70-4729-a9e7-276530eb9282",
                        "restaurantName": "Panorama Sv. Ivan",
                        "author": "Stan",
                        "rating": 4,
                        "comment": "I liked the mussels",
                        "_createdOn": 1680528779730,
                        "_id": "416dd6de-a605-4256-b701-b13a5b1ba689"
                    }
                ],
                "_createdOn": 1680527378604,
                "_id": "81bff2c2-6c70-4729-a9e7-276530eb9282",
                "_updatedOn": 1680528779756
            },
            "e5ac9d89-8a59-463f-84da-1c92113c506f": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "name": "Restaurant Apolonia",
                "address": "Lulin 7, Sozopol 8130 Bulgaria",
                "phone": "+359889012210",
                "capacity": "100",
                "imageUrl": "https://static.pochivka.bg/restaurants.bgstay.com/images/restaurants/00/694/55d44506b4444.jpg",
                "summary": "Before 30 years ago there were just some tables and delicious food in the backyard of a small house. 30 years later there are more tables, more visitors , I can say now its a small family restaurant with traditions and the same delicious food!",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea3",
                        "restaurantId": "e5ac9d89-8a59-463f-84da-1c92113c506f",
                        "restaurantName": "Restaurant Apolonia",
                        "author": "Stan",
                        "rating": 5,
                        "comment": "Very nice and quiet place!",
                        "_createdOn": 1680528807889,
                        "_id": "8731d518-e399-4a5b-94d5-fd9ba8ed8d03"
                    }
                ],
                "_createdOn": 1680527890712,
                "_id": "e5ac9d89-8a59-463f-84da-1c92113c506f",
                "_updatedOn": 1680528807917
            },
            "8b0a1750-7169-47c0-b7db-e701f90aba6e": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea3",
                "name": "Ksantana",
                "address": "Morski Skali, 7, Sozopol 8130 Bulgaria",
                "phone": "+359889012210",
                "capacity": "80",
                "imageUrl": "https://static.pochivka.bg/restaurants.bgstay.com/images/restaurants/00/692/55d1a5a1608ed.jpg",
                "summary": "Bulgarian cuisine",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                        "restaurantId": "8b0a1750-7169-47c0-b7db-e701f90aba6e",
                        "restaurantName": "Ksantana",
                        "author": "Peter",
                        "rating": 3,
                        "comment": "This restaurant has a great location with sunset views but I'm afraid that's the best it has to offer. The service wasn't too bad but could have been much better. The food was distinctly average and bore no resemblance to the menu. If you want sunsets then have a drink here but personally I'd avoid having dinner here.",
                        "_createdOn": 1680529123463,
                        "_id": "a6be9269-e6f0-44ff-87ae-fc60af4e3bb4"
                    }
                ],
                "_createdOn": 1680528417855,
                "_id": "8b0a1750-7169-47c0-b7db-e701f90aba6e",
                "_updatedOn": 1680529123475
            },
            "0371ef2c-69d2-49a3-819f-0562cf0c2848": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea3",
                "name": "Antichen Kladenec",
                "address": "Kiril i Metodii 35, Sozopol 8130 Bulgaria",
                "phone": "+359123123123",
                "capacity": "70",
                "imageUrl": "https://static.pochivka.bg/restaurants.bgstay.com/images/restaurants/01/1578/55ffc5e34fe48.jpg",
                "summary": "Visit us and taste some Armenian foods and drinks! Food is fresh, made with love and served fast! We are waiting for you! ",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                        "restaurantId": "0371ef2c-69d2-49a3-819f-0562cf0c2848",
                        "restaurantName": "Antichen Kladenec",
                        "author": "Peter",
                        "rating": 5,
                        "comment": "We had to wait three days to get a table here. You shoud book a table in advance in order to sit here for a late dinner. Finally we got it and we had a chance to taste delightful local dishes. That was really an amazing experience.",
                        "_createdOn": 1680529155480,
                        "_id": "f77ccb30-6c8c-4be2-9418-2018455699bc"
                    }
                ],
                "_createdOn": 1680528700151,
                "_id": "0371ef2c-69d2-49a3-819f-0562cf0c2848",
                "_updatedOn": 1680529155501
            },
            "e1aed097-2f87-40e3-86b7-f6d4d72bb1a2": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
                "name": "The Old Sozopol Bistro",
                "address": "Kraybrezhna41, Sozopol 8130 Bulgaria",
                "phone": "+359889012210",
                "capacity": "80",
                "imageUrl": "https://media-cdn.tripadvisor.com/media/photo-s/1d/52/27/6c/the-old-sozopol-bistro.jpg",
                "summary": "Small, tidy restaurant, with a beautiful terrace, to the old port.National traditional cuisine. Mediterranean cuisine, fresh fish and meat. once you come, you will come back again.",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                        "restaurantId": "e1aed097-2f87-40e3-86b7-f6d4d72bb1a2",
                        "restaurantName": "The Old Sozopol Bistro",
                        "author": "Pesho",
                        "rating": 5,
                        "comment": "I barely write reviews but this time i have to. This place should be higher ranked. The staff is super friendly as well as the service. Nice and cozy interior. The prices are more then correct and the food is amazing! Great job guys!",
                        "_createdOn": 1680530024726,
                        "_id": "fb2c3388-64b0-49d9-8ba3-898a6e5b6563"
                    }
                ],
                "_createdOn": 1680529484455,
                "_id": "e1aed097-2f87-40e3-86b7-f6d4d72bb1a2",
                "_updatedOn": 1680530024758
            },
            "77d83905-e75e-474c-a215-2e2ce41d6b1b": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
                "name": "Casa Del Mare",
                "address": "Kiril i Metodii 36, Sozopol 8130 Bulgaria",
                "phone": "+359123123123",
                "capacity": "130",
                "imageUrl": "http://hotelcasadelmare.com/media/Restorant-1.jpg",
                "summary": "Restaurant Casa del Mare is situated on the most picturesque and romantic place in the Ancient Sozopol. The Southern Castle Wall Museum is adjacent to the restaurant. The beautiful sea scenic view revealed to the guests of the restaurant leaves them with lasting memories and warm feelings. ",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                        "restaurantId": "77d83905-e75e-474c-a215-2e2ce41d6b1b",
                        "restaurantName": "Casa Del Mare",
                        "author": "Pesho",
                        "rating": 4,
                        "comment": "My wife and I liked the food here. We tried some of the seafood and for our daughter some chicken tenders which were amazing! Overall this place is really nice and the only reason we give it a 4/5 it's because, even though the service was good the guy that served at out table seemed like he was forced to do this for a living. Not a smile, nothing.",
                        "_createdOn": 1680530059336,
                        "_id": "25ee78e4-3965-44b5-8f01-91d71393d0b1"
                    }
                ],
                "_createdOn": 1680529610065,
                "_id": "77d83905-e75e-474c-a215-2e2ce41d6b1b",
                "_updatedOn": 1680530059357
            },
            "e93dd0f4-fa50-4aff-9e8a-b8e69bb927a0": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                "name": "Marina Beach Bar",
                "address": "Santa Marina Holiday Village Beach 2, Sozopol 8130 Bulgaria",
                "phone": "+359123123123",
                "capacity": "70",
                "imageUrl": "https://media-cdn.tripadvisor.com/media/photo-s/17/2e/b5/63/marina-beach-bar.jpg",
                "summary": "You will reach Marina Beach Bar with a 10-minute walk from the Old Town of Sozopol. Marina Beach Bar is the best place to enjoy care-free summers by the water. A bar with refreshments on the beach, chaise-longues, spacious tents, dressing rooms and secured swimming space with lifeguards are all at your disposal.",
                "reviews": [
                    {
                        "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                        "restaurantId": "e93dd0f4-fa50-4aff-9e8a-b8e69bb927a0",
                        "restaurantName": "Marina Beach Bar",
                        "author": "Pesho",
                        "rating": 5,
                        "comment": "I loved this little bar, great serice, views & food, coconut fried prawns to die for! Relax on the beach, have a beer in the shade, eat good food, whats not to like.",
                        "_createdOn": 1680530093669,
                        "_id": "dce11c2c-7d77-4ec6-88be-d5a043fd118a"
                    }
                ],
                "_createdOn": 1680529755468,
                "_id": "e93dd0f4-fa50-4aff-9e8a-b8e69bb927a0",
                "_updatedOn": 1680530093695
            },
            "0f4c1eed-0494-47dc-a314-82fed4591fe4": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "name": "Anel Restaurant",
                "address": "Via Pontica 145 Art Complex Anel, Sozopol 8130 Bulgaria",
                "phone": "+359889012210",
                "capacity": "120",
                "imageUrl": "https://cf.bstatic.com/images/hotel/max1024x768/274/274399704.jpg",
                "summary": "Visit us and see the difference!",
                "reviews": [],
                "_createdOn": 1680529985445,
                "_id": "0f4c1eed-0494-47dc-a314-82fed4591fe4"
            },
            "c882aace-c624-46f3-acd4-0952de724843": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "name": "El Greco",
                "address": "Milet Str. 30, Sozopol 8130 Bulgaria",
                "phone": "+359123123123",
                "capacity": "60",
                "imageUrl": "https://media-cdn.tripadvisor.com/media/photo-s/0b/83/d4/f8/salle-interieure.jpg",
                "summary": "Italian, Pizza, Seafood",
                "reviews": [],
                "_createdOn": 1680530272668,
                "_id": "c882aace-c624-46f3-acd4-0952de724843"
            },
            "a0ed473e-3c6d-4d0c-aae7-d3263d7c090e": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "name": "Mekhana Shatrite",
                "address": "Ropotamo 32 Plyazhna Aleya, Sozopol 8130 Bulgaria",
                "phone": "+359123123123",
                "capacity": "250",
                "imageUrl": "https://media-cdn.tripadvisor.com/media/photo-m/1280/19/44/7b/cf/sozopol-mehana-shatrite.jpg",
                "summary": "Traditional Bulgarian food! Live music!",
                "reviews": [],
                "_createdOn": 1680530400759,
                "_id": "a0ed473e-3c6d-4d0c-aae7-d3263d7c090e"
            }
        },
        reviews: {
            "8d7fa12f-3669-453b-adc6-550d6295f6c4": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
                "restaurantId": "1840a313-225c-416a-817a-9954d4609f7c",
                "restaurantName": "Pri hudojnicite",
                "rating": 3,
                "author": "John",
                "comment": "Good!",
                "_createdOn": 1678708464033,
                "_id": "8d7fa12f-3669-453b-adc6-550d6295f6c4"
            },
            "8d7fa12f-3669-453b-adc6-550d6295f6c2": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "restaurantId": "126777f5-3277-42ad-b874-76d043b069cb",
                "restaurantName": "Boca Grande",
                "rating": 5,
                "author": "Peter",
                "comment": "Excellent!",
                "_createdOn": 1678708464033,
                "_id": "8d7fa12f-3669-453b-adc6-550d6295f6c2"
            },
            "8d7fa12f-3669-453b-adc6-550d6295f6c3": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "restaurantId": "126777f5-3277-42ad-b874-76d043b069cd",
                "restaurantName": "Coral",
                "rating": 4,
                "author": "Peter",
                "comment": "Very good!",
                "_createdOn": 1678708464073,
                "_id": "8d7fa12f-3669-453b-adc6-550d6295f6c3"
            },
            "8d7fa12f-3669-453b-adc6-550d6295f6c8": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                "restaurantId": "126777f5-3277-42ad-b874-76d043b069cd",
                "restaurantName": "Coral",
                "rating": 5,
                "author": "Ivan",
                "comment": "Nice place!",
                "_createdOn": 1678707454013,
                "_id": "8d7fa12f-3669-453b-adc6-550d6295f6c8"
            },
            "742ae8ac-0c42-4cb9-b030-0bfd4a1e4253": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                "restaurantId": "ff436770-76c5-40e2-b231-77409eda7a61",
                "restaurantName": "Viaturna Melnica",
                "author": "Ivan",
                "rating": 5,
                "comment": "Perfect meals! I love it!",
                "_createdOn": 1680525605810,
                "_id": "742ae8ac-0c42-4cb9-b030-0bfd4a1e4253"
            },
            "81b2ec07-bb85-45b7-908d-c41faae5c090": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                "restaurantId": "126777f5-3277-42ad-b874-76d043b069cb",
                "restaurantName": "Boca Grande",
                "author": "Ivan",
                "rating": 5,
                "comment": "Great meals! Luxury design!",
                "_createdOn": 1680525695853,
                "_id": "81b2ec07-bb85-45b7-908d-c41faae5c090"
            },
            "cfa2c0ed-a420-436f-b80a-b24ad3b6d9de": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                "restaurantId": "1840a313-225c-416a-817a-9954d4609f7c",
                "restaurantName": "Pri hudojnicite",
                "author": "Ivan",
                "rating": 4,
                "comment": "The view from terrace was very beautiful! Тhe service was not up to par!",
                "_createdOn": 1680525962845,
                "_id": "cfa2c0ed-a420-436f-b80a-b24ad3b6d9de"
            },
            "635bfdf1-4dea-417a-8f41-2f5da7cb76d4": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                "restaurantId": "cab97cb0-690d-429c-baea-c10409ff7a8e",
                "restaurantName": "Black Bison Grill & Bar",
                "author": "Todor",
                "rating": 5,
                "comment": "The chiken burgers was so delicious!",
                "_createdOn": 1680526545411,
                "_id": "635bfdf1-4dea-417a-8f41-2f5da7cb76d4"
            },
            "c2621cc6-3ec4-43b6-a287-54119f297d25": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                "restaurantId": "9fe6b7b0-040b-42df-9a9c-c4cb0bf1df85",
                "restaurantName": "Albatros",
                "author": "Todor",
                "rating": 5,
                "comment": "Best restaurant in Sozopol!",
                "_createdOn": 1680526609934,
                "_id": "c2621cc6-3ec4-43b6-a287-54119f297d25"
            },
            "78f2f679-16a3-470c-bd64-6bd6da39cca6": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                "restaurantId": "ff436770-76c5-40e2-b231-77409eda7a61",
                "restaurantName": "Viaturna Melnica",
                "author": "Todor",
                "rating": 4,
                "comment": "Delicious food, but a little noisy!",
                "_createdOn": 1680526683143,
                "_id": "78f2f679-16a3-470c-bd64-6bd6da39cca6"
            },
            "56838567-e961-431b-8dfb-16924e8a8f42": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                "restaurantId": "126777f5-3277-42ad-b874-76d043b069cd",
                "restaurantName": "Coral",
                "author": "Todor",
                "rating": 5,
                "comment": "Small family restaurant! I love it! The service was perfect!",
                "_createdOn": 1680526747168,
                "_id": "56838567-e961-431b-8dfb-16924e8a8f42"
            },
            "ef86da0c-4bdf-455e-a091-fa2af5ebf5c5": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea1",
                "restaurantId": "126777f5-3277-42ad-b874-76d043b069cb",
                "restaurantName": "Boca Grande",
                "author": "Todor",
                "rating": 3,
                "comment": "Good, but a little expensive!",
                "_createdOn": 1680526799006,
                "_id": "ef86da0c-4bdf-455e-a091-fa2af5ebf5c5"
            },
            "8ae13886-e095-46a6-9e27-8939df914f08": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                "restaurantName": "Del Muro",
                "author": "Ivan",
                "rating": 5,
                "comment": "Excellent!",
                "_createdOn": 1680527034679,
                "_id": "8ae13886-e095-46a6-9e27-8939df914f08"
            },
            "08a2a090-4d6a-4232-b43e-5e40af0f2773": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                "restaurantId": "b51fcde2-3514-4484-9c41-69f8cf9ab9b4",
                "restaurantName": "Veranda",
                "author": "Ivan",
                "rating": 3,
                "comment": "Good!",
                "_createdOn": 1680527055175,
                "_id": "08a2a090-4d6a-4232-b43e-5e40af0f2773"
            },
            "9ddd5e00-d32a-4c00-9f34-d4981ae1aaee": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                "restaurantName": "Del Muro",
                "author": "Pesho",
                "rating": 5,
                "comment": "Lovely restaurant, perfect for a romantic dinner. The food was very fresh and tasty and the service was very nice",
                "_createdOn": 1680527951083,
                "_id": "9ddd5e00-d32a-4c00-9f34-d4981ae1aaee"
            },
            "e250b3a1-656a-4d9b-857a-da3fac71e570": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "restaurantId": "126777f5-3277-42ad-b874-76d043b069cb",
                "restaurantName": "Boca Grande",
                "author": "Pesho",
                "rating": 5,
                "comment": "We were very satisfied with the food, drinks and the services! The waiter was very polite and tended to our table whenever we needed something.The view is also spectacular. Highly recommended!",
                "_createdOn": 1680527998205,
                "_id": "e250b3a1-656a-4d9b-857a-da3fac71e570"
            },
            "239e78bf-8e05-44db-9b95-64a21a13fe6f": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "restaurantId": "126777f5-3277-42ad-b874-76d043b069cd",
                "restaurantName": "Coral",
                "author": "Pesho",
                "rating": 5,
                "comment": "Food was excellent! And the staff was very responsive and friendly. It is very busy at night, so I recommend to book a table in advance. The salads with rose tomato, the tuna tartar and the sea tongue are a must!",
                "_createdOn": 1680528047738,
                "_id": "239e78bf-8e05-44db-9b95-64a21a13fe6f"
            },
            "5bdc79d5-4f14-44db-ba64-2d8d49585266": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "restaurantId": "1840a313-225c-416a-817a-9954d4609f7c",
                "restaurantName": "Pri hudojnicite",
                "author": "Pesho",
                "rating": 1,
                "comment": "The food (mussels, meat) wasn’t good, salads are crap, 1 sweet waitress is handling all the tables and things are happening very slow",
                "_createdOn": 1680528125566,
                "_id": "5bdc79d5-4f14-44db-ba64-2d8d49585266"
            },
            "d9ec5c30-2688-4edd-8fd3-444fa742f80b": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "restaurantId": "b51fcde2-3514-4484-9c41-69f8cf9ab9b4",
                "restaurantName": "Veranda",
                "author": "Pesho",
                "rating": 4,
                "comment": "Nice terrace place with outdoor seating. In the heart of the new town. Tasty and cheap. Very friendly staff:)",
                "_createdOn": 1680528195013,
                "_id": "d9ec5c30-2688-4edd-8fd3-444fa742f80b"
            },
            "416dd6de-a605-4256-b701-b13a5b1ba689": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea3",
                "restaurantId": "81bff2c2-6c70-4729-a9e7-276530eb9282",
                "restaurantName": "Panorama Sv. Ivan",
                "author": "Stan",
                "rating": 4,
                "comment": "I liked the mussels",
                "_createdOn": 1680528779730,
                "_id": "416dd6de-a605-4256-b701-b13a5b1ba689"
            },
            "8731d518-e399-4a5b-94d5-fd9ba8ed8d03": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea3",
                "restaurantId": "e5ac9d89-8a59-463f-84da-1c92113c506f",
                "restaurantName": "Restaurant Apolonia",
                "author": "Stan",
                "rating": 5,
                "comment": "Very nice and quiet place!",
                "_createdOn": 1680528807889,
                "_id": "8731d518-e399-4a5b-94d5-fd9ba8ed8d03"
            },
            "e38b0763-b380-4794-9266-565ed81d6fa0": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea3",
                "restaurantId": "9fe6b7b0-040b-42df-9a9c-c4cb0bf1df85",
                "restaurantName": "Albatros",
                "author": "Stan",
                "rating": 5,
                "comment": "Great food, a very friendly staff, atmosphere in the restaurant is ok, nothing special but very clean. All In all, a must visit place in Sozopol.",
                "_createdOn": 1680528885893,
                "_id": "e38b0763-b380-4794-9266-565ed81d6fa0"
            },
            "9f7e690b-0478-43e8-8288-6e65d6568eef": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea3",
                "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                "restaurantName": "Del Muro",
                "author": "Stan",
                "rating": 5,
                "comment": "Our favorite. Great food, service, atmosphere. Easily best one in Sozopol, going steadily for years, never disappointed so far.",
                "_createdOn": 1680528934863,
                "_id": "9f7e690b-0478-43e8-8288-6e65d6568eef"
            },
            "6f18f407-9be5-442b-addc-33f26bcb7f48": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "restaurantId": "cab97cb0-690d-429c-baea-c10409ff7a8e",
                "restaurantName": "Black Bison Grill & Bar",
                "author": "Peter",
                "rating": 5,
                "comment": "The best burger place in Sozopol. One of the most delicious onion rings I have ever tried when combined with their secret homemade sauce!",
                "_createdOn": 1680529026363,
                "_id": "6f18f407-9be5-442b-addc-33f26bcb7f48"
            },
            "460d561b-a138-4df2-a2a3-613e2c93263d": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "restaurantId": "9fe6b7b0-040b-42df-9a9c-c4cb0bf1df85",
                "restaurantName": "Albatros",
                "author": "Peter",
                "rating": 5,
                "comment": "This is one of the best small restaurant i have ever been. The food is so tasty and the menu is perfect. The servise in hi-top level. I love it :-)",
                "_createdOn": 1680529077319,
                "_id": "460d561b-a138-4df2-a2a3-613e2c93263d"
            },
            "a6be9269-e6f0-44ff-87ae-fc60af4e3bb4": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "restaurantId": "8b0a1750-7169-47c0-b7db-e701f90aba6e",
                "restaurantName": "Ksantana",
                "author": "Peter",
                "rating": 3,
                "comment": "This restaurant has a great location with sunset views but I'm afraid that's the best it has to offer. The service wasn't too bad but could have been much better. The food was distinctly average and bore no resemblance to the menu. If you want sunsets then have a drink here but personally I'd avoid having dinner here.",
                "_createdOn": 1680529123463,
                "_id": "a6be9269-e6f0-44ff-87ae-fc60af4e3bb4"
            },
            "f77ccb30-6c8c-4be2-9418-2018455699bc": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "restaurantId": "0371ef2c-69d2-49a3-819f-0562cf0c2848",
                "restaurantName": "Antichen Kladenec",
                "author": "Peter",
                "rating": 5,
                "comment": "We had to wait three days to get a table here. You shoud book a table in advance in order to sit here for a late dinner. Finally we got it and we had a chance to taste delightful local dishes. That was really an amazing experience.",
                "_createdOn": 1680529155480,
                "_id": "f77ccb30-6c8c-4be2-9418-2018455699bc"
            },
            "40df948b-150d-456e-85fc-eafe67505d35": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                "restaurantName": "Del Muro",
                "author": "Peter",
                "rating": 5,
                "comment": "Went there with my wife. Make sure to make a reservation for the terrace (first lone). Beautiful place with an amazing view. Service was great too. Very friendly and professional staff.",
                "_createdOn": 1680529211491,
                "_id": "40df948b-150d-456e-85fc-eafe67505d35"
            },
            "0f6657c5-2cba-49aa-9266-9fc2c0dc6891": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
                "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                "restaurantName": "Del Muro",
                "author": "John",
                "rating": 5,
                "comment": "Incredible place, just amazing food and service!!! Recommend it!!! The best place in Sozopol! I love it!",
                "_createdOn": 1680529310920,
                "_id": "0f6657c5-2cba-49aa-9266-9fc2c0dc6891"
            },
            "1dbe9ca5-d557-492c-9509-80eb8ba8d95e": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
                "restaurantId": "9fe6b7b0-040b-42df-9a9c-c4cb0bf1df85",
                "restaurantName": "Albatros",
                "author": "John",
                "rating": 4,
                "comment": "Located not in the very beach, however, it offers quite a lot of fish. They produce their own beer and this is always a plus. Interesting.",
                "_createdOn": 1680529353473,
                "_id": "1dbe9ca5-d557-492c-9509-80eb8ba8d95e"
            },
            "fb2c3388-64b0-49d9-8ba3-898a6e5b6563": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "restaurantId": "e1aed097-2f87-40e3-86b7-f6d4d72bb1a2",
                "restaurantName": "The Old Sozopol Bistro",
                "author": "Pesho",
                "rating": 5,
                "comment": "I barely write reviews but this time i have to. This place should be higher ranked. The staff is super friendly as well as the service. Nice and cozy interior. The prices are more then correct and the food is amazing! Great job guys!",
                "_createdOn": 1680530024726,
                "_id": "fb2c3388-64b0-49d9-8ba3-898a6e5b6563"
            },
            "25ee78e4-3965-44b5-8f01-91d71393d0b1": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "restaurantId": "77d83905-e75e-474c-a215-2e2ce41d6b1b",
                "restaurantName": "Casa Del Mare",
                "author": "Pesho",
                "rating": 4,
                "comment": "My wife and I liked the food here. We tried some of the seafood and for our daughter some chicken tenders which were amazing! Overall this place is really nice and the only reason we give it a 4/5 it's because, even though the service was good the guy that served at out table seemed like he was forced to do this for a living. Not a smile, nothing.",
                "_createdOn": 1680530059336,
                "_id": "25ee78e4-3965-44b5-8f01-91d71393d0b1"
            },
            "dce11c2c-7d77-4ec6-88be-d5a043fd118a": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea2",
                "restaurantId": "e93dd0f4-fa50-4aff-9e8a-b8e69bb927a0",
                "restaurantName": "Marina Beach Bar",
                "author": "Pesho",
                "rating": 5,
                "comment": "I loved this little bar, great serice, views & food, coconut fried prawns to die for! Relax on the beach, have a beer in the shade, eat good food, whats not to like.",
                "_createdOn": 1680530093669,
                "_id": "dce11c2c-7d77-4ec6-88be-d5a043fd118a"
            },
            "18aa3411-8fb5-4d47-963a-91bf6ca217c4": {
                "_ownerId": "085224ee-a2fb-4af6-8b02-a68d35f487b3",
                "restaurantId": "26e4a065-679f-47cf-94af-9ac3faeeb2da",
                "restaurantName": "Del Muro",
                "author": "Elizabeth",
                "rating": 5,
                "comment": "Perfect place!",
                "_createdOn": 1680530506416,
                "_id": "18aa3411-8fb5-4d47-963a-91bf6ca217c4"
            },
            "6bb647d1-73c1-412d-9b24-232776baf123": {
                "_ownerId": "085224ee-a2fb-4af6-8b02-a68d35f487b3",
                "restaurantId": "126777f5-3277-42ad-b874-76d043b069cd",
                "restaurantName": "Coral",
                "author": "Elizabeth",
                "rating": 5,
                "comment": "Nice small restaurant",
                "_createdOn": 1680530550460,
                "_id": "6bb647d1-73c1-412d-9b24-232776baf123"
            }

        },
        favourites: {
            "75ce39b5-ea44-4a6d-ae4d-303440c66f77": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "restaurantId": "126777f5-3277-42ad-b874-76d043b069cb",
                "restaurantName": "Boca Grande",
                "imageUrl": "https://gradat.bg/sites/default/files/styles/page_article_dynamic_width/public/mainimages/o_3045804_0.jpg?itok=Te1DzaI8",
                "_createdOn": 1679666632574,
                "_id": "75ce39b5-ea44-4a6d-ae4d-303440c66f77"
            },
            "f2ef2dbe-e7f3-4f22-9134-b730b84e08a1": {
                "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93b",
                "restaurantId": "ff436770-76c5-40e2-b231-77409eda7a61",
                "restaurantName": "Viaturna Melnica",
                "imageUrl": "https://fastly.4sqi.net/img/general/600x600/32551704_l_uL8IULNtcByxgmcCtPPtZQL4_swnvqekBtyLN7XIE.jpg",
                "_createdOn": 1680525578642,
                "_id": "f2ef2dbe-e7f3-4f22-9134-b730b84e08a1"
            },
            "adb134f8-8381-438c-afeb-680b2b563d93": {
                "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
                "restaurantId": "0371ef2c-69d2-49a3-819f-0562cf0c2848",
                "restaurantName": "Antichen Kladenec",
                "imageUrl": "https://static.pochivka.bg/restaurants.bgstay.com/images/restaurants/01/1578/55ffc5e34fe48.jpg",
                "_createdOn": 1680529151722,
                "_id": "adb134f8-8381-438c-afeb-680b2b563d93"
            }
        }

    };
    var rules$1 = {
        users: {
            ".create": false,
            ".read": [
                "Owner"
            ],
            ".update": false,
            ".delete": false
        }
    };
    var settings = {
        identity: identity,
        protectedData: protectedData,
        seedData: seedData,
        rules: rules$1
    };

    const plugins = [
        storage(settings),
        auth(settings),
        util$2(),
        rules(settings)
    ];

    const server = http__default['default'].createServer(requestHandler(plugins, services));

    const port = 3030;
    server.listen(port);
    console.log(`Server started on port ${port}. You can make requests to http://localhost:${port}/`);
    console.log(`Admin panel located at http://localhost:${port}/admin`);

    var softuniPracticeServer = {

    };

    return softuniPracticeServer;

})));
