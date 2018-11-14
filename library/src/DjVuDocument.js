import DjViChunk from './chunks/DjViChunk';
import DjVuPage from './DjVuPage';
import DIRMChunk from './chunks/DirmChunk';
import NAVMChunk from './chunks/NavmChunk';
import DjVuWriter from './DjVuWriter';
import DjVu from './DjVu';
import ThumChunk from './chunks/ThumChunk';
import ByteStream from './ByteStream';
import {
    IncorrectFileFormatDjVuError,
    NoSuchPageDjVuError,
    CorruptedFileDjVuError,
    NoBaseUrlDjVuError,
    UnsuccessfulRequestDjVuError,
    NetworkDjVuError,
} from './DjVuErrors';

const MEMORY_LIMIT = 50 * 1024 * 1024; // 50 MB

export default class DjVuDocument {
    constructor(arraybuffer, { baseUrl = null, memoryLimit = MEMORY_LIMIT } = {}) {
        this.buffer = arraybuffer;
        this.baseUrl = baseUrl && baseUrl.trim();
        if (this.baseUrl !== null && this.baseUrl) {
            if (this.baseUrl[this.baseUrl.length - 1] !== '/') {
                this.baseUrl += '/';
            }
            if (!/^http/.test(this.baseUrl)) { // a relative URL
                this.baseUrl = new URL(this.baseUrl, location.origin).href; // all URL in a worker should be absolute
            }
        }
        this.memoryLimit = memoryLimit; // required to limit the size of cache in case of indirect djvu

        this.djvi = {}; //разделяемые ресурсы. Могут потребоваться и в случае одностраничного документа
        this.getINCLChunkCallback = id => this.djvi[id].innerChunk;

        this.bs = new ByteStream(arraybuffer);
        this.formatID = this.bs.readStr4();
        if (this.formatID !== 'AT&T') {
            throw new IncorrectFileFormatDjVuError();
        }
        this.id = this.bs.readStr4();
        this.length = this.bs.getInt32();
        this.id += this.bs.readStr4();
        if (this.id === 'FORMDJVM') {
            this._initMultiPageDocument();
        } else if (this.id === 'FORMDJVU') {
            this.bs.jump(-12);
            this.pages = [new DjVuPage(this.bs.fork(this.length + 8), this.getINCLChunkCallback)];
        } else {
            throw new CorruptedFileDjVuError(`The id of the first chunk of the document should be either FORMDJVM or FORMDJVU, but there is ${this.id}!`);
        }
    }

    _initMultiPageDocument() { // for FORMDJVM
        this._readMetaDataChunk();
        this._readContentsChunkIfExists();

        /**
         * @type {Array<DjVuPage>}
         */
        this.pages = []; //страницы FORMDJVU
        this.thumbs = [];
        this.idToPageNumberMap = {}; // used to get pages by their id (url)

        if (this.dirm.isBundled) {
            this._parseComponents();
        } else {
            this.pages = new Array(this.dirm.getPagesQuantity()); // fixed length array in order to know what pages are loaded and what are not.
            this.memoryUsage = this.bs.buffer.byteLength;
            this.loadedPageNumbers = [];
        }
    }

    _readMetaDataChunk() { // DIRM chunk
        var id = this.bs.readStr4();
        if (id !== 'DIRM') {
            throw new CorruptedFileDjVuError("The DIRM chunk must be the first but there is " + id + " instead!");
        }
        var length = this.bs.getInt32();
        this.bs.jump(-8);
        this.dirm = new DIRMChunk(this.bs.fork(length + 8)); // document directory, metadata for multi-page documents
        this.bs.jump(8 + length + (length & 1 ? 1 : 0));
    }

    _readContentsChunkIfExists() { // NAVM chunk
        this.navm = null; // человеческое оглавление 
        if (this.bs.remainingLength() > 8) {
            var id = this.bs.readStr4();
            var length = this.bs.getInt32();
            this.bs.jump(-8);
            if (id === 'NAVM') {
                this.navm = new NAVMChunk(this.bs.fork(length + 8))
            }
        }
    }

    _parseComponents() {
        // all chunks of the file in the order which they are listed in the DIRM chunk
        this.dirmOrderedChunks = new Array(this.dirm.getFilesQuantity());

        for (var i = 0; i < this.dirm.offsets.length; i++) {
            this.bs.setOffset(this.dirm.offsets[i]);
            var id = this.bs.readStr4();
            var length = this.bs.getInt32();
            id += this.bs.readStr4();
            this.bs.jump(-12);
            switch (id) {
                case "FORMDJVU":
                    this.pages.push(this.dirmOrderedChunks[i] = new DjVuPage(
                        this.bs.fork(length + 8),
                        this.getINCLChunkCallback
                    ));
                    this.idToPageNumberMap[this.dirm.ids[i]] = this.pages.length;
                    break;
                case "FORMDJVI":
                    //через строчку id chunk INCL ссылается на нужный ресурс
                    this.dirmOrderedChunks[i] = this.djvi[this.dirm.ids[i]] = new DjViChunk(this.bs.fork(length + 8));
                    break;
                case "FORMTHUM":
                    this.thumbs.push(this.dirmOrderedChunks[i] = new ThumChunk(this.bs.fork(length + 8)));
                    break;
                default:
                    console.error("Incorrect chunk ID: ", id);
            }
        }
    }

    isBundled() {
        return this.dirm ? this.dirm.isBundled : true;
    }

    getPagesQuantity() {
        return this.dirm ? this.dirm.getPagesQuantity() : 1;
    }

    getContents() {
        return this.navm ? this.navm.getContents() : null;
    }

    getMemoryUsage() {
        return this.memoryUsage;
    }

    getMemoryLimit() {
        return this.memoryLimit;
    }

    setMemoryLimit(limit = MEMORY_LIMIT) {
        this.memoryLimit = limit;
    }

    getPageNumberByUrl(url) {
        if (url[0] !== '#') {
            return null;
        }

        var ref = url.slice(1);
        var pageNumber = this.idToPageNumberMap[ref];
        if (!pageNumber) {
            var num = Math.round(Number(ref));
            if (num >= 1 && num <= this.pages.length) { // there can be refs like "#057";
                pageNumber = num;
            }
        }

        return pageNumber || null;
    }

    releaseMemoryIfRequired(preservedDependencies = null) {
        if (this.memoryUsage <= this.memoryLimit) {
            //console.log(`%c Memory wasnt released  ${this.memoryUsage}, ${this.memoryLimit}, ${this.loadedPageNumbers.length}, ${Object.keys(this.djvi).length}`, "color: green");
            return;
        }
        //var was = this.memoryUsage;
        while (this.memoryUsage > this.memoryLimit && this.loadedPageNumbers.length) {
            var number = this.loadedPageNumbers.shift();
            this.memoryUsage -= this.pages[number].bs.buffer.byteLength;
            this.pages[number] = null;
        }

        if (this.memoryUsage > this.memoryLimit && !this.loadedPageNumbers.length) { // remove all dictionaries, if there is no pages
            this.resetLastRequestedPage();

            var newDjVi = {};
            if (preservedDependencies) {
                preservedDependencies.forEach(id => {
                    newDjVi[id] = this.djvi[id];
                    this.memoryUsage += newDjVi[id].bs.buffer.byteLength; // will be subtracted back further
                });
            }
            Object.keys(this.djvi).forEach(key => {
                this.memoryUsage -= this.djvi[key].bs.buffer.byteLength;
            });

            this.djvi = newDjVi;
        }
        //console.log(`%c Memory was released ${was}, ${this.memoryUsage}, ${this.loadedPageNumbers.length}, ${Object.keys(this.djvi).length}`, "color: red");
    }

    async getPage(number) {
        var page = this.pages[number - 1];
        if (this.lastRequestedPage && this.lastRequestedPage !== page) {
            this.lastRequestedPage.reset();
        }
        this.lastRequestedPage = page;

        if (!page) {
            if (number < 1 || number > this.pages.length || this.isBundled()) {
                throw new NoSuchPageDjVuError(number);
            } else {
                if (this.baseUrl === null) {
                    throw new NoBaseUrlDjVuError();
                }
                var pageName = this.dirm.getPageNameByItsNumber(number);
                var url = this.baseUrl + pageName;

                try {
                    var response = await fetch(url);
                } catch (e) {
                    throw new NetworkDjVuError({ pageNumber: number, url: url });
                }

                if (!response.ok) {
                    throw new UnsuccessfulRequestDjVuError(response, { pageNumber: number });
                }

                var pageBuffer = await response.arrayBuffer();
                var bs = new ByteStream(pageBuffer);
                if (bs.readStr4() !== 'AT&T') {
                    throw new CorruptedFileDjVuError(`The file gotten as the page number ${number} isn't a djvu file!`);
                }

                var page = new DjVuPage(bs.fork(), this.getINCLChunkCallback);
                this.memoryUsage += pageBuffer.byteLength;
                await this._loadDependencies(page.getDependencies(), number);

                this.releaseMemoryIfRequired(page.getDependencies()); // should be called before the page are added to the pages array
                this.pages[number - 1] = page;
                this.loadedPageNumbers.push(number - 1);
                this.lastRequestedPage = page;
            }
        } else if (!this.isOnePageDependenciesLoaded && this.id === "FORMDJVU") { // single page document
            var dependencies = page.getDependencies();
            if (dependencies.length) {
                await this._loadDependencies(dependencies, 1);
            }
            this.isOnePageDependenciesLoaded = true;
        }

        return this.lastRequestedPage;
    }

    async _loadDependencies(dependencies, pageNumber = null) {
        var unloadedDependencies = dependencies.filter(id => !this.djvi[id]);
        if (!unloadedDependencies.length) {
            return;
        }
        await Promise.all(unloadedDependencies.map(async id => {
            var url = this.baseUrl + (this.dirm ? this.dirm.getComponentNameByItsId(id) : id);

            try {
                var response = await fetch(url);
            } catch (e) {
                throw new NetworkDjVuError({ pageNumber: pageNumber, dependencyId: id, url: url });
            }

            if (!response.ok) {
                throw new UnsuccessfulRequestDjVuError(response, { pageNumber: pageNumber, dependencyId: id });
            }

            var componentBuffer = await response.arrayBuffer();
            var bs = new ByteStream(componentBuffer);
            if (bs.readStr4() !== 'AT&T') {
                throw new CorruptedFileDjVuError(
                    `The file gotten as a dependency ${id} ${pageNumber ? `for the page number ${pageNumber}` : ''} isn't a djvu file!`
                );
            }

            var chunkId = bs.readStr4();
            var length = bs.getInt32();
            chunkId += bs.readStr4();
            if (chunkId !== "FORMDJVI") {
                throw new CorruptedFileDjVuError(
                    `The file gotten as a dependency ${id} ${pageNumber ? `for the page number ${pageNumber}` : ''} isn't a djvu file with shared data!`
                );
            }
            this.djvi[id] = new DjViChunk(bs.jump(-12).fork(length + 8));
            this.memoryUsage += componentBuffer.byteLength;
        }));
    }

    getPageUnsafe(number) {
        return this.pages[number - 1];
    }

    resetLastRequestedPage() {
        this.lastRequestedPage && this.lastRequestedPage.reset();
        this.lastRequestedPage = null;
    }

    countFiles() {
        var count = 0;
        var bs = this.bs.clone();
        bs.jump(16);
        while (!bs.isEmpty()) {
            var chunk;
            var id = bs.readStr4();
            var length = bs.getInt32();
            bs.jump(-8);
            // вернулись назад
            var chunkBs = bs.fork(length + 8);
            // перепрыгнули к следующей порции
            bs.jump(8 + length + (length & 1 ? 1 : 0));
            if (id === 'FORM') {
                count++;
            }
        }
        return count;
    }

    /**
     * Возвращает метаданные документа. 
     * @param {Boolean} html - заменять ли \n на <br>
     * @returns {string} строка метаданных
     */
    toString(html) {
        var str = this.formatID + '\n';
        if (this.dirm) { // multi page document
            str += this.id + " " + this.length + '\n\n';
            str += this.dirm.toString();
            str += this.navm ? this.navm.toString() : '';
            this.dirmOrderedChunks.forEach((chunk, i) => {
                str += this.dirm.getMetadataStringByIndex(i) + chunk.toString();
            });
        } else { // single page document
            str += this.pages[0].toString();
        }

        return html ? str.replace(/\n/g, '<br>').replace(/\s/g, '&nbsp;') : str;
    }

    /**
     * Создает ссылку для скачивания документа
     */
    createObjectURL() {
        var blob = new Blob([this.bs.buffer]);
        var url = URL.createObjectURL(blob);
        return url;
    }

    /**
     *  Creates a new DjVuDocument with pages from "from" to "to", including first and last pages.
     */
    slice(from = 1, to = this.pages.length) {
        //Globals.Timer.start('sliceTime');
        var djvuWriter = new DjVuWriter();
        djvuWriter.startDJVM();
        var dirm = {};
        dirm.dflags = this.dirm.dflags;
        var pageNumber = to - from + 1;
        dirm.flags = [];
        dirm.names = [];
        dirm.titles = [];
        dirm.sizes = [];
        dirm.ids = [];
        var chunkBS = [];
        var pageIndex = 0;
        var addedPageCount = 0;
        // все зависимости страниц в новом документе
        // нужно чтобы не копировать лишние словари
        var dependencies = {};

        // находим все зависимости в первом проходе
        for (var i = 0; i < this.dirm.nfiles && addedPageCount < pageNumber; i++) {
            var isPage = (this.dirm.flags[i] & 63) === 1;
            if (isPage) {
                pageIndex++;
                if (pageIndex < from) {
                    continue;
                }
                else {
                    addedPageCount++;
                    var cbs = new ByteStream(this.buffer, this.dirm.offsets[i], this.dirm.sizes[i]);
                    var deps = new DjVuPage(cbs).getDependencies();
                    cbs.reset();
                    for (var j = 0; j < deps.length; j++) {
                        dependencies[deps[j]] = 1;
                    }
                }
            }
        }

        pageIndex = 0;
        addedPageCount = 0;
        // теперь все словари и страницы, которые нужны
        for (var i = 0; i < this.dirm.nfiles && addedPageCount < pageNumber; i++) {
            var isPage = (this.dirm.flags[i] & 63) === 1;
            if (isPage) {
                pageIndex++;
                //если она не входит в заданный дапазон
                if (pageIndex < from) {
                    continue;
                } else {
                    addedPageCount++;
                }
            }


            //копируем страницы и словари. Эскизы пропускаем - пока что это не реализовано
            if ((this.dirm.ids[i] in dependencies) || isPage) {
                dirm.flags.push(this.dirm.flags[i]);
                dirm.sizes.push(this.dirm.sizes[i]);
                dirm.ids.push(this.dirm.ids[i]);
                dirm.names.push(this.dirm.names[i]);
                dirm.titles.push(this.dirm.titles[i]);
                var cbs = new ByteStream(this.buffer, this.dirm.offsets[i], this.dirm.sizes[i]);
                chunkBS.push(cbs);
            }
        }

        djvuWriter.writeDirmChunk(dirm);
        if (this.navm) {
            djvuWriter.writeChunk(this.navm);
        }

        for (var i = 0; i < chunkBS.length; i++) {
            djvuWriter.writeFormChunkBS(chunkBS[i]);
        }
        var newbuffer = djvuWriter.getBuffer();
        DjVu.IS_DEBUG && console.log("New Buffer size = ", newbuffer.byteLength);
        var doc = new DjVuDocument(newbuffer);
        //Globals.Timer.end('sliceTime');
        return doc;
    }

    /**
     * Функция склейки двух документов
     */
    static concat(doc1, doc2) {
        var dirm = {};
        var length = doc1.pages.length + doc2.pages.length;
        dirm.dflags = 129;
        dirm.flags = [];
        dirm.sizes = [];
        dirm.ids = [];
        var pages = [];
        var idset = new Set(); // чтобы убрать повторяющиеся id

        if (!doc1.dirm) { // тогда  записываем свой id
            dirm.flags.push(1);
            dirm.sizes.push(doc1.pages[0].bs.length);
            dirm.ids.push('single');
            idset.add('single');
            pages.push(doc1.pages[0]);
        }
        else {
            for (var i = 0; i < doc1.pages.length; i++) {
                dirm.flags.push(doc1.dirm.flags[i]);
                dirm.sizes.push(doc1.dirm.sizes[i]);
                dirm.ids.push(doc1.dirm.ids[i]);
                idset.add(doc1.dirm.ids[i]);
                pages.push(doc1.pages[i]);
            }
        }
        if (!doc2.dirm) { // тогда  записываем свой id
            dirm.flags.push(1);
            dirm.sizes.push(doc2.pages[0].bs.length);

            var newid = 'single2';
            var tmp = 0;
            while (idset.has(newid)) { // генерируем уникальный id
                newid = 'single2' + tmp.toString();
                tmp++;
            }
            dirm.ids.push(newid);
            pages.push(doc2.pages[0]);
        }
        else {
            for (var i = 0; i < doc2.pages.length; i++) {
                dirm.flags.push(doc2.dirm.flags[i]);
                dirm.sizes.push(doc2.dirm.sizes[i]);
                var newid = doc2.dirm.ids[i];
                var tmp = 0;
                while (idset.has(newid)) { // генерируем уникальный id
                    newid = doc2.dirm.ids[i] + tmp.toString();
                    tmp++;
                }
                dirm.ids.push(newid);
                idset.add(newid);
                pages.push(doc2.pages[i]);
            }
        }

        var dw = new DjVuWriter();
        dw.startDJVM();
        dw.writeDirmChunk(dirm);
        for (var i = 0; i < length; i++) {
            dw.writeFormChunkBS(pages[i].bs);
        }

        return new DjVuDocument(dw.getBuffer());

    }
}
