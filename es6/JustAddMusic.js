/*
* MIT License
* 
* Copyright (c) 2017 gskinner.com, inc.
* 
* Permission is hereby granted, free of charge, to any person obtaining a copy
* of this software and associated documentation files (the "Software"), to deal
* in the Software without restriction, including without limitation the rights
* to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
* copies of the Software, and to permit persons to whom the Software is
* furnished to do so, subject to the following conditions:
* 
* The above copyright notice and this permission notice shall be included in all
* copies or substantial portions of the Software.
* 
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
* SOFTWARE.
*/

class JustAddMusic {
	/*
	TODO:
	- add color and balance outputs?
	- re-evaluate whether volume should affect analyser
	*/
	constructor(config) {
		if (!config || typeof config === "string") { config = {src:config}; }
		
	// public properties:
		this.mode = config.mode||0;
		this.gain = config.gain||1;
		this.onstart = config.onstart;
		this.ontick = config.ontick;
		this.onprogress = config.onprogress;
		this.label = config.label||"";
		
	// private properties:
		// getter / setter values:
		this._paused = !!config.paused;
		this._keyControl = false;
		this._tickInterval = 0;
		this._tickIntervalID = 0;
		
		// file load:
		this._request = null;
		
		// state:
		this._playT = 0;
		this._pausedT = 0;
		this._ui = false;
		this._uiDiv = null;
		
		// analyser:
		this._audioData = null;
		this._deltaT = config.deltaT||50;
		this._avgT = config.avgT||150;
		this._maxT = Math.max(this._deltaT, this._avgT);
		
		// web audio:
		this._context = null;
		this._gainNode = null;
		this._sourceNode = null;
		this._buffer = null;
		
		// method proxies:
		this._bound_handleKeyDown = this._handleKeyDown.bind(this);
		
		// init:
		this._initAudio();
		this._initUI();
		this._initDropTarget(config.dropTarget);
		
		// setup:
		this.tickInterval = config.tickInterval;
		this.loadAudio(config.src);
		this.ui = config.ui===undefined?true:config.ui;
		this.keyControl = config.keyControl===undefined?true:config.keyControl;
		this.volume = config.volume===undefined?1:config.volume;
	}
	
	
// getter / setters:
	get paused() { return this._paused; }
	set paused(val) {
		!val ? this.play() : this.pause();
	}
	
	get keyControl() { return this._keyControl; }
	set keyControl(val) {
		val = !!val;
		if (this._keyControl === val) { return; }
		this._keyControl = val;
		if (val) { document.addEventListener("keydown", this._bound_handleKeyDown); }
		else { document.removeEventListener("keydown", this._bound_handleKeyDown); }
	}
	
	get tickInterval() { return this._tickInterval; }
	set tickInterval(val=16) {
		if (this._tickIntervalID !== undefined) {
			clearInterval(this._tickIntervalID);
			this._tickIntervalID = null;
		}
		if (val > 0) {
			this._tickIntervalID = setInterval(this.tick.bind(this), val);
		}
	}
	
	get volume() { return this._gainNode.gain.value; }
	set volume(val) {
		this._gainNode.gain.value = Math.max(0, Math.min(2, val));
	}
	
	get ui() { return this._ui; }
	set ui(val) {
		val = !!val;
		if (this._ui === val) { return; }
		this._ui = val;
		let div = this._uiDiv;
		if (val) { document.body.appendChild(div); }
		else { div.parentNode.removeChild(div); }
	}
	
	get audioData() { return this._audioData[0]||{vol:0,avg:0,delta:0,avgDelta:0,t:0}; }
	
	
// public methods:
	// file load:
	loadAudio(src) {
		this.abort();
		if (!src) { return; }
		this._updateLoadUI(0);
		let request = this._request = new XMLHttpRequest();
		request.open('GET', src, true);
		request.responseType = 'arraybuffer';
		request.addEventListener("load", this._handleURILoad.bind(this));
		request.addEventListener("progress", this._handleURIProgress.bind(this));
		request.send();
	}
	
	abort() {//
		this._request&&this._request.abort();
		this._request = null;
	}
	
	// playback:
	play() {
		let bufferChanged = (this._sourceNode&&this._sourceNode.buffer) !== this._buffer;
		
		let offset = this._pausedT;
		this.pause(); // disconnect the old source node.
		
		let source = this._sourceNode = this._context.createBufferSource();
		source.buffer = this._buffer;
		source.connect(this._gainNode);
		source.start(0, offset);
		this._playT = this._context.currentTime - offset;
		this._paused = false;
		bufferChanged&&this.onstart&&this.onstart();
	}
	
	pause() {
		if (!this._sourceNode || this._paused) { return; }
		this._sourceNode.stop();
		this._sourceNode.disconnect();
		this._sourceNode = null;
		this._pausedT = this._context.currentTime - this._playT;
		this._paused = true;
	}
	
	stop() {
		this.abort();
		this.pause();
		this._pausedT = this._playT = 0;
	}
	
	skip(time) {
		if (!this._buffer) { return; }
		
		if (this._paused) { this._pausedT += time; }
		else {
			this._pausedT = Math.min(this._buffer.duration, Math.max(0, this._context.currentTime - this._playT + time));
			this.play();
		}
	}
	
	tick() {
		if (!this._sourceNode) { return; }
		this._updateTimeUI();
		if (!this.ontick && this._tickIntervalID) { return; }
		!this._analyserNode&&this._initAnalyser();
		
		let waveForm = this._freqData, mode = this.mode, t = (new Date()).getTime(), val = 0, i, l;
		this._analyserNode.getByteTimeDomainData(waveForm);
		
		//TODO: it would be nice to have a color (aka pitch) and balance (aka pan) value.
		for (i=0, l=waveForm.length; i<l; i++) {
			let r = waveForm[i]/128-1; // analyser data is monaural unless you split the channels.
			if (r < 0) { r *= -1; }
			if (mode===1) { val += r*r; } // RMS
			else if (mode === 2) { val += r; } // average
			else if (r > val) { val = r; } // peak
		}
		
		if (mode === 1) { val = Math.sqrt(val/l); }
		else if (mode === 2) { val /= l; }
		
		val = 1-Math.pow(1-val, this.gain);
		if (val > 1) { val = 1; }
		
		let data = this._audioData, o = {vol:val, t:t};
		data.unshift(o);
		
		// calculate the delta and average values:
		let sum = val, count = 1, deltaO = data[1];
		for (i=1, l=data.length; i<l; i++) {
			let o2 = data[i];
			if (o2.t >= t-this._avgT) { sum += o2.vol; count++; }
			if (o2.t >= t-this._deltaT) { deltaO = o2; }
			if (o2.t < t-this._maxT) { data.pop(); l--; }
		}
		o.avg = sum/count;
		o.delta = deltaO ? val-deltaO.vol : 0;
		o.avgDelta = deltaO ? o.avg-deltaO.avg : 0;
		
		
		this.ontick&&this.ontick(o);
		return o;
	};
	
	toString() {
		return "[JustAddMusic]";
	}
	
// private methods:
	_initAudio() {
		this._context = new (window.AudioContext||window.webkitAudioContext)();
		this._gainNode = this._context.createGain();
		this._gainNode.connect(this._context.destination);
	}
	
	_initAnalyser() {
		if (this._analyserNode) { return; }
		let ctx = this._context;
		this._audioData = [];
		
		// create an analyser node
		this._analyserNode = ctx.createAnalyser();
		this._analyserNode.fftSize = 128;  //The size of the FFT used for frequency-domain analysis. This must be a power of two
		this._analyserNode.smoothingTimeConstant = 0;  //A value from 0 -> 1 where 0 represents no time averaging with the last analysis frame
		this._analyserNode.connect(ctx.destination);  // connect to the context.destination, which outputs the audio
		
		// reconnect the gain node:
		this._gainNode.disconnect();
		this._gainNode.connect(this._analyserNode);

		// set up the array that we use to retrieve the analyserNode data
		this._freqData = new Uint8Array(this._analyserNode.frequencyBinCount);
	}
	
	_initDropTarget(target) {
		if (target === undefined) { target = window; }
		if (typeof target === "string") { target = document.querySelector(target); }
		if (!target) { return; }
		target.addEventListener("drop", this._handleDrop.bind(this));
		target.addEventListener("dragenter", this._handleDragEnter.bind(this));
		target.addEventListener("dragleave", this._handleDragLeave.bind(this));
		target.addEventListener("dragover", this._handleDragOver.bind(this));
		this._updateUI("drop an MP3 to play");
	}
	
	_decode(data) {
		this._context.decodeAudioData(data, this._handleBufferDecode.bind(this));
		this._updateUI("decoding...");
	}

	// UI:
	_initUI() {
		let div = this._uiDiv = document.createElement("div");
		div.className = "jam-ui";
		let sheet = document.createElement("style");
		sheet.innerHTML = ".jam-ui { padding: 0.75em; font-size: 10pt; font-family: arial, sans-serif; background: black; color: white; z-index: 100; position:absolute; bottom:0; left:0; letter-spacing: 0.02em }";
		// dump this at the top of head so it's easy to override.
		document.head.insertBefore(sheet, document.head.firstChild);
	}
	
	_updateLoadUI(p) {
		this._updateUI(Math.round(p*100)+"%");
	}
	
	_updateTimeUI() {
		if (!this._buffer) { return; }
		let str = this._formatTime(Math.min(this._buffer.duration, this._context.currentTime - this._playT));
		str += " / " + this._formatTime(this._buffer.duration);
		this._updateUI(str);
	}
	
	_formatTime(t) {
		let m = t/60|0, s=Math.round(t-m*60);
		return m+":"+(s<10?"0":"")+s;
	}
	
	_updateUI(str) {
		let div = this._uiDiv;
		div.style.display = !str ? "none" : "inline-block";
		div.innerHTML = this.label+str;
	}
	
	// event handlers:
	_handleKeyDown(evt) {
		let key = evt.key;
		if (key === " ") {
			this.paused = !this.paused;
		} else if (key === "Enter") {
			this._pausedT = 0;
			this.play();
		} else if (key === "ArrowUp" || key === "ArrowDown") {
			this.volume += 0.1 * (key === "ArrowUp" ? 1 : -1);
		} else if (key === "ArrowLeft" || key === "ArrowRight") {
			let s = (key === "ArrowLeft" ? -1 : 1) * (evt.shiftKey ? 15 : 5) * (evt.altKey ? 12 : 1);
			this.skip(s);
		}
	}
	
	_handleDragEnter(evt) {
		this._handleDragLeave(evt);
		let el = evt.currentTarget, target = el === window ? document.body : el;
		target.className += " jam-drop";
	}
	
	_handleDragLeave(evt) {
		evt.preventDefault();
		let el = evt.currentTarget, target = el === window ? document.body : el;
		target.className = target.className.replace(/\b\s?jam-drop\b/, "");
	}
	
	_handleDragOver(evt) {
		this._handleDragEnter(evt)
	}
	
	_handleDrop(evt) {
		this._handleDragLeave(evt);
		this.abort();
		let reader = new FileReader();
		reader.addEventListener('load', this._handleDropLoad.bind(this));
		reader.readAsArrayBuffer(evt.dataTransfer.files[0]);
	}
	
	_handleDropLoad(evt) {
		this._decode(evt.target.result);
	}
	
	_handleURILoad(evt) {
		this._decode(evt.target.response);
		this._request = null;
	}
	
	_handleURIProgress(evt) {
		let p = evt.loaded / evt.total;
		this.onprogress&&this.onprogress(p);
		this._updateLoadUI(p);
	}
	
	_handleBufferDecode(buffer) {
		this._buffer = buffer;
		this._pausedT = 0;
		this._playT = this._context.currentTime;
		this._updateTimeUI();
		if (!this._paused) { this.play(); }
	}
}

JustAddMusic.PEAK = 0;
JustAddMusic.RMS = 1;
JustAddMusic.AVERAGE = 2;