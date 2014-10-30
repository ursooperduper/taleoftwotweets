var _             = require('lodash');
var Client        = require('node-rest-client').Client;
var Twit          = require('twit');
var async         = require('async');
var inflection    = require('inflection');
var wordFilter    = require('wordfilter');

var t = new Twit({
  consumer_key        : process.env.TWOTWEETS_CONSUMER_KEY,
  consumer_secret     : process.env.TWOTWEETS_CONSUMER_SECRET,
  access_token        : process.env.TWOTWEETS_ACCESS_TOKEN,
  access_token_secret : process.env.TWOTWEETS_ACCESS_TOKEN_SECRET
});
var wordnikKey        = process.env.WORDNIK_API_KEY;

setupBot = function(cb) {
  var botData = {
    tweetTerms              : ['best', 'worst'],
    tweetQueryPool          : [],
    tweetCandidatePool      : [],
    partsOfSpeech           : [],
    nextWords               : []
  };
  cb(null, botData);
};

getPublicTweets = function(searchTerm, cb) {
  t.get('search/tweets', {
    q             : searchTerm, 
    count         : 10, 
    result_type   : 'recent', 
    lang          : 'en'
  }, function(err, data, response) {
    if (!err) {
      cb(null, data);
    } else {
      cb(err, data);
    }
  });
};

findCandidateTweets = function(botData, cb) {
  async.map(botData.tweetTerms, getPublicTweets, function(err, results) { 
    botData.tweetQueryPool = results;
    cb(err, botData);
  });
};

examineCandidateTweets = function(botData, cb) {
  var bestTweets          = [];
  var worstTweets         = [];
  var excludeNonAlpha     = /[^a-zA-Z]+/;
  var excludeURLs         = /https?:\/\/[-a-zA-Z0-9@:%_\+.~#?&\/=]+/g;
  var excludeShortAlpha   = /\b[a-z][a-z]?\b/g;
  var excludeHandles       = /@[a-z0-9_-]+/g;
  var excludePatterns     = [excludeURLs, excludeShortAlpha, excludeHandles];
  var excludedWords       = ['and', 'rt', 'the'];
  
  _.each(botData.tweetQueryPool, function(pool) {
    var query             = pool.search_metadata.query;
    
    _.each(pool.statuses, function(status) {
      var tweetObj = {
        baseTweet         : status.text, 
        tweetid           : status.id_str,
        username          : status.user.screen_name,
        nextWord          : ''
      };
     
      _.each(excludePatterns, function(pat) {
        tweetObj.baseTweet = tweetObj.baseTweet.replace(pat, ' ');
      });

      var words = tweetObj.baseTweet.toLowerCase().split(excludeNonAlpha);
      words = _.reject(words, function(w) {
        return _.contains(excludedWords, w);
      });

      var indexOfTerm     = _.indexOf(words, query);
      tweetObj.nextWord   = words[indexOfTerm + 1];
      botData.nextWords.push(tweetObj.nextWord);

      if (query == 'best') {
        bestTweets.push(tweetObj);
      } else {
        worstTweets.push(tweetObj);
      }
    });
  });
  botData.tweetCandidatePool.push(bestTweets);
  botData.tweetCandidatePool.push(worstTweets);
  cb(null, botData);
};

getAllWordData = function(botData, cb) {
  async.map(botData.nextWords, getWordData, function(err, result) {
    botData.partsOfSpeech = result;
    cb(null, botData);
  });
};

getWordData = function(word, cb) {
  var client = new Client();
  var wordnikURLPart1    = 'http://api.wordnik.com:80/v4/word.json/';
  var wordnikURLPart2    = '/definitions?limit=1&includeRelated=false&useCanonical=true&includeTags=false&api_key=';
  var args = {
    headers: {'Accept':'application/json'}
  };
  var wordnikURL = wordnikURLPart1 + word + wordnikURLPart2 + wordnikKey;
  client.get(wordnikURL, args, function(data, response) {
    if (response.statusCode === 200) {
      var returnedData = JSON.parse(data);    
      if (returnedData.length) {
        var result = returnedData[0].partOfSpeech;
        cb(null, result);
      } else {
        cb(null, null);
      }
    } else {
      cb(null, null);
    }
  });
};

pickNouns = function(botData, cb) {
  var bestNounList          = botData.partsOfSpeech.slice(0,10);
  var worstNounList         = botData.partsOfSpeech.slice(10,20);
  botData.bestIndex         = _.indexOf(bestNounList, 'noun');
  botData.worstIndex        = _.indexOf(worstNounList, 'noun');
  botData.best              = botData.tweetCandidatePool[0][botData.bestIndex];
  botData.worst             = botData.tweetCandidatePool[1][botData.worstIndex];
  botData.bestNoun          = botData.best.nextWord;
  botData.worstNoun         = botData.worst.nextWord;
  cb(null, botData);
};

composeTweet = function(botData, cb) {
  var tweetPart1      = 'It was the best of ';
  var tweetPart2      = ', it was the worst of ';
  var twitterURL      = 'http://twitter.com/';
  var line1           = tweetPart1 + inflection.pluralize(botData.bestNoun) + tweetPart2 + inflection.pluralize(botData.worstNoun) + '.';
  var line2           = twitterURL + botData.best.username + '/status/' + botData.best.tweetid;
  var line3           = twitterURL + botData.worst.username + '/status/' + botData.worst.tweetid;
  botData.tweetBlock  = line1 + '\n' + line2 + '\n' + line3;
  cb(null, botData);
};

postTweet = function(botData, cb) {
  if (!wordFilter.blacklisted(botData.tweetBlock)) {
    t.post('statuses/update', {status: botData.tweetBlock}, function(err, data, response) {
      cb(err, botData);
    });
  }
};

run = function() {  
  async.waterfall([
    setupBot,
    findCandidateTweets,
    examineCandidateTweets, 
    getAllWordData,
    pickNouns,
    composeTweet,
    postTweet
  ], 
  function(err, botData) {
    if (err) {
      console.log('There was an error posting to Twitter: ', err);
    } else {
      console.log('Tweet successful!');
      console.log('Tweet: ', botData.tweetBlock);
    }
    console.log('Best base Tweet: ', botData.best.baseTweet);
    console.log('Worst base Tweet: ', botData.worst.baseTweet);
  });
};

setInterval(function() {
  try {
    run();
  } 
  catch (e) {
    console.log(e);
  }
}, 60000 * 60);

