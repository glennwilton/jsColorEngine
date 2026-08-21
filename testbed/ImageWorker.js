class ImageWorker
{
    constructor() {
    }

    public addWorker(id, funcStr){
        var blob = new Blob([funcStr], {type: 'application/javascript'});
        this.workers[id] = new Worker(URL.createObjectURL(blob));
        return this.workers[id];
    }

    public removeWorker(id){
        this.workers[id].terminate();
        delete this.workers[id];
    }

    public removeWorkers() {
        for (var id in this.workers) {
            this.workers[id].terminate();
        }
        this.workers = {};
    }

    public getWorker = function(id){
        return this.workers[id];
    }

    public getOrCreateWorker = function(id, funcStr){
    if(this.workers[id] === undefined){
        return this.addWorker(id, funcStr);
    }
    return this.workers[id];
}
}