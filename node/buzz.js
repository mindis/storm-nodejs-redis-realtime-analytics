/** Imports **/
var express = require('express')
 ,   app = express() 
 , http = require('http')
 , server = require('http').createServer(app)
 , io = require('socket.io').listen(server)
 , redis = require('redis')

;

server.listen(8080);

// Globals
var ChannelCounts = new Object();

var POS = "pos";
var NEG = "neg";
var NEUT = "neutral";

var labels = [POS, NEG, NEUT];
var channels = ["GoogleAlerts"];

var ES_HOST = 'localhost';
var ES_PORT = 9200;
var ES_INDEX = 'ticks';

var processFacetResult = function(facetResult) {
    var sentFacet = facetResult.facets.sentiment;
    if (sentFacet) {
        console.log('Got sentiment facet');
        counts = new Object();
        counts['channel'] = 'GoogleAlerts';
        counts[POS] = 0;
        counts[NEG] = 0;
        counts[NEUT] = 0;
        ChannelCounts['GoogleAlerts'] = counts;
        
        for (var i = 0; i < sentFacet.terms.length; i++) {
            var termCount = sentFacet.terms[i];
            console.log('TermCount:' + termCount.term + '=' + termCount.count);
            if (counts[termCount.term]) {
                counts[termCount.term] += termCount.count;
            } else  {
                counts[termCount.term] = termCount.count;
            }
        }
    }
    console.log('Got sentiment counts from ES: ' + JSON.stringify(ChannelCounts));
    io.sockets.emit('counts', ChannelCounts['GoogleAlerts']);
};

/** Get initial counts from elasticsearch */
var exec = require('child_process').exec;
var getcounts = exec("./getcounts.sh", function(error, stdout, stderr) {
    console.log('Shell script output:' + stdout);
    processFacetResult(JSON.parse(stdout));
});

/** Socket.io **/
io.sockets.on('connection', function(socket) {
    console.log(' <<<<<< User connected');
    // Send latest counts
    for (var i = 0; i < channels.length; i++) {
        var channel = channels[i];
        if (ChannelCounts[channel]) {
            socket.emit('counts', ChannelCounts[channel]);
        }
    }
    socket.on('disconnect', function() {
        console.log(' >>>>>>>> User disconnected');
    });
    
    socket.on('search', function(data) {
        console.log('NEW SEARCH REQUEST ' + JSON.stringify(data));
        var from = 0;
        if (data.from) {
            from = data.from;
        }
        var size = 10;
        if (data.pageSize) {
            size = data.pageSize;
        }
        
        var options = {
          hostname: ES_HOST,
          port: ES_PORT,
          path: ES_INDEX + '/_search?q=sentiment:' + data.sentiment + '&size='+size+'&sort=publishedAt:desc&from='+from,
          method: 'GET'
        };
        
        console.log('Sending search req to ' + options.path);
        
        var req = http.request(options, function(res) {
            // Send the query result back to the client
            var chunks = new Array();
            res.on('data', function(chunk) {
                chunks.push(chunk);
            });
            
            res.on('end', function () {
                // Send the response to browser
                socket.emit('search_results', {
                    'channel': data.channel,
                    'label': data.sentiment,
                    'result_body': chunks.join("")
                });
            });
        });
        req.end();
        console.log('search request sent to ES:' + data.channel + ', ' + data.label);
    });
});

/** Web endpoints and Express setup **/
app.use(express.logger());
app.use("/static", express.static(__dirname + '/static'));

app.get('/', function (req, res) {
    res.sendfile(__dirname + '/index.html');
});

/** Redis **/
var redisClient = redis.createClient();
for (var i = 0; i < channels.length; i++) {
    redisClient.subscribe(channels[i]);
}

var saveInES = function(message) {
    var msg = JSON.parse(message);
    var options = {
      hostname: ES_HOST,
      port: ES_PORT,
      path: ES_INDEX + '/' + msg.channel + '/' + msg.id,
      method: 'PUT'
    };

    var req = http.request(options, function(res) {
    });

    req.write(message + '\n');
    req.end();
    console.log('written to ES:' + message.id);
};

var updateCounts = function(inmsgStr) {
    var inmsg = JSON.parse(inmsgStr);
    var channel = inmsg.channel;
    var label = inmsg.sentiment;
    console.log('%%%%%%%%%%%%%%%%%%%% ' + inmsg.title + ' ' + label);

    // Update counts for the channel
    var counts = ChannelCounts[channel];        
    if (!counts) {
      counts = new Object();
      counts['channel'] = channel;
      counts[POS] = 0;
      counts[NEG] = 0;
      counts[NEUT] = 0;
      ChannelCounts[channel] = counts;
    }
    var precount = counts[label];
    if (precount) {
        counts[label] = precount + 1;
    } else {
        counts[label] = 1;
    }
    console.log('Sending count:' + JSON.stringify(ChannelCounts[channel]));
    io.sockets.emit('counts', ChannelCounts[channel]);
    io.sockets.emit('tick', inmsg);
};
  
redisClient.on('message', function (channel, message) {
    console.log('New event on ' + channel); 
    console.log('####### MESSAGE ' +  message);
    saveInES(message);
    updateCounts(message);
    console.log('Sent message and counts to clients');
});
