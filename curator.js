var fs = require('fs');
var readline = require('readline');
var { google } = require('googleapis');
var OAuth2 = google.auth.OAuth2;
var moment = require('moment');
var service = google.youtube('v3');

const SCOPES = ['https://www.googleapis.com/auth/youtube'];
const AUTH_DIR = './auth/'
const TOKEN_PATH = AUTH_DIR + 'youtube-nodejs-quickstart.ign.json';
const TIMESTAMP_PATH = './latestVideoTimestamp.txt'

fs.readFile(AUTH_DIR + 'client_secret.ign.json', function processClientSecrets(err, content) {
    if (err) {
        console.log('Error loading client secret file: ' + err);
        return;
    }
    // Authorize a client with the loaded credentials, then call the YouTube API.
    authorize(JSON.parse(content), updateSubscriptions);
});

function authorize(credentials, callback) {
    var clientSecret = credentials.installed.client_secret;
    var clientId = credentials.installed.client_id;
    var redirectUrl = credentials.installed.redirect_uris[0];
    var oauth2Client = new OAuth2(clientId, clientSecret, redirectUrl);

    // Check if we have previously stored a token.
    fs.readFile(TOKEN_PATH, function (err, token) {
        if (err) {
            getNewToken(oauth2Client, callback);
        } else {
            oauth2Client.credentials = JSON.parse(token);
            callback(oauth2Client);
        }
    });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 *
 * @param {google.auth.OAuth2} oauth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback to call with the authorized
 *     client.
 */
function getNewToken(oauth2Client, callback) {
    var authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES
    });
    console.log('Authorize this app by visiting this url: ', authUrl);
    var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question('Enter the code from that page here: ', function (code) {
        rl.close();
        oauth2Client.getToken(code, function (err, token) {
            if (err) {
                console.log('Error while trying to retrieve access token', err);
                return;
            }
            oauth2Client.credentials = token;
            storeToken(token);
            callback(oauth2Client);
        });
    });
}

/**
 * Store token to disk be used in later program executions.
 *
 * @param {Object} token The token to store to disk.
 */
function storeToken(token) {
    try {
        fs.mkdirSync(AUTH_DIR);
    } catch (err) {
        if (err.code != 'EEXIST') {
            throw err;
        }
    }
    fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) throw err;
        console.log('Token stored to ' + TOKEN_PATH);
    });
}

async function updateSubscriptions(auth) {

    var allSubs = [], nextPageToken;

    // Go through all pages of subscriptions and concat with allSubs array
    while (nextPageToken || allSubs.length == 0) {
        var paginatedSubResponse = await service.subscriptions.list({
            auth: auth,
            part: 'snippet',
            mine: true,
            maxResults: 50,
            pageToken: nextPageToken,
            order: 'alphabetical',
        })
        nextPageToken = paginatedSubResponse.data.nextPageToken;
        allSubs = allSubs.concat(paginatedSubResponse.data.items);
    }

    const uploadsForEachSub = await Promise.all(allSubs.map(async subscription => {
        // Get channel object associated with subscription
        const channelResponse = await service.channels.list({
            auth: auth,
            part: 'contentDetails, snippet',
            id: subscription.snippet.resourceId.channelId,
            maxResults: 1,
        });

        // Get the channels 'uploads' playlist
        const uploadPlaylistResponse = await service.playlists.list({
            auth: auth,
            part: 'id',
            id: channelResponse.data.items[0].contentDetails.relatedPlaylists.uploads,
            maxResults: 1,
        });

        // Get the most recent 50 videos of the upload playlist (already sorted by most recent in response)
        const videoResponse = await service.playlistItems.list({
            auth: auth,
            part: 'snippet, contentDetails',
            playlistId: uploadPlaylistResponse.data.items[0].id,
            maxResults: 50,
        });

        return videoResponse.data.items;
    }));

    var unfilteredUploads = [].concat.apply([], uploadsForEachSub);

    var currentDaysUploads = await filterForCurrentDay(unfilteredUploads);
    currentDaysUploads = await getVideoDurationsAndTags(auth, currentDaysUploads);
    currentDaysUploads = applyChannelFilters(currentDaysUploads);

    // Sort videos by time uploaded, least recent first
    currentDaysUploads = currentDaysUploads.sort((video1, video2) => {
        return moment(video1.contentDetails.videoPublishedAt).unix() - moment(video2.contentDetails.videoPublishedAt).unix();
    })

    await addVideosToPlaylists(auth, currentDaysUploads);

    // Save timestamp of most recent video to file so next time we know the starting point (if there were new vids)
    if (currentDaysUploads.length > 0)
    {
        await fs.promises.writeFile(TIMESTAMP_PATH, currentDaysUploads[currentDaysUploads.length - 1].contentDetails.videoPublishedAt);
        console.log('Last timestamp saved to ' + TIMESTAMP_PATH);
    }
}

async function filterForCurrentDay(unfilteredUploads) {
    const now = moment();
    var lastTimestamp = null;
    try {
        lastTimestamp = await fs.promises.readFile(TIMESTAMP_PATH, 'utf-8');
    }
    catch {
        lastTimestamp = now.clone().subtract(1, 'days');
    }

    // Filter for videos between now and the last timestamp
    const currentDaysVideos = unfilteredUploads.filter(video => {
        return moment(video.contentDetails.videoPublishedAt).isAfter(lastTimestamp) && moment(video.contentDetails.videoPublishedAt).isBefore(now);
    });

    return currentDaysVideos;
}

async function addVideosToPlaylists(auth, videoList) {
    // Get all of users playlists
    const myPlaylistsResponse = await service.playlists.list({
        auth: auth,
        part: 'id, snippet',
        mine: true,
        maxResults: 20,
    });

    // Find subscription playlist
    const subPlaylist = myPlaylistsResponse.data.items.find(playlist => {
        return playlist.snippet.title == 'Subscriptions';
    });

    // Find car playlist
    const carPlaylist = myPlaylistsResponse.data.items.find(playlist => {
        return playlist.snippet.title == 'Car';
    });

    // Videos less than or equal to 30 mins are added to subscriptions
    const subVideos = videoList.filter(video => {
        return video.duration <= 30;
    });

    // Videos greater than 30 mins are added to cars
    const carVideos = videoList.filter(video => {
        return video.duration > 30;
    });

    // Sequentially insert videos into sub playlist
    subVideos.reduce(async (prevPromise, nextVid) => {
        await prevPromise;
        return service.playlistItems.insert({
            auth: auth,
            part: 'snippet',
            resource:
            {
                snippet: {
                    resourceId: nextVid.snippet.resourceId,
                    playlistId: subPlaylist.id,
                }
            }
        });
    }, Promise.resolve());

    // Sequentially insert videos into car playlist
    carVideos.reduce( async (prevPromise, nextVid) => {
        await prevPromise;
        return service.playlistItems.insert({
            auth: auth,
            part: 'snippet',
            resource:
            {
                snippet: {
                    resourceId: nextVid.snippet.resourceId,
                    playlistId: carPlaylist.id,
                }
            }
        });
    }, Promise.resolve());
}

async function getVideoDurationsAndTags(auth, videoList) {
    // For each playlist item, get its video object so we can get the duration (formatted to minutes) and tags
    videoList = await Promise.all(videoList.map(async video => {
        const videoResponse = await service.videos.list({
            auth: auth,
            part: 'contentDetails, snippet',
            id: video.snippet.resourceId.videoId,
            maxResults: 1,
        });

        video.duration = moment.duration(videoResponse.data.items[0].contentDetails.duration).asMinutes();
        video.tags = videoResponse.data.items[0].snippet.tags;
        return video;
    }));

    return videoList;
}

function applyChannelFilters(videoList) {
    // Below are filters for certain types of videos I never watch

    videoList = videoList.filter(video => {
        switch (video.snippet.channelTitle) {

            // Only hip-hop and rap reviews from theneedledrop
            case ('theneedledrop'):
                return video.snippet.title.toLowerCase().includes('review') &&
                    (video.tags.includes('rap') || video.tags.includes('hip hop'));

            // Only hip-hop and rap reviews from fantano
            case ('fantano'):
                return (video.snippet.title.toLowerCase().includes('memes') ||
                    video.tags.includes('rap') || video.tags.includes('hip hop')) && !/20\d\d/.test(video.snippet.title);

            // Only Mic'd up and Game highlights from NFL's Channel
            case ('NFL'):
                return video.snippet.title.includes('Mic\'d Up') ||
                    (video.snippet.title.includes('Highlights') && !video.snippet.title.includes('Season'));

            // Remove Arlo news roundups, wishlist vids, and top 10s
            case ('Arlo'):
                return !video.snippet.title.toLowerCase().includes('news roundup') &&
                    !video.snippet.title.toLowerCase().includes('predict') &&
                    !video.snippet.title.toLowerCase().includes('wishlist');

            // Remove WAN show from LinusTechTips
            case ('Linus Tech Tips'):
                return !video.snippet.title.toLowerCase().includes('wan show');

            // Only Hot Ones from First We Feast
            case ('First We Feast'):
                return video.snippet.title.includes('Hot Ones');

            // Only Smash and Nintendo Reactions from Max Dood
            case ('Maximilian Dood'):
                return video.snippet.title.toLowerCase().includes('super smash bros') ||
                    video.snippet.title.includes('Nintendo');

            // Only SM64 vids from Simply
            case ('Simply'):
                return video.snippet.title.toLowerCase().includes('sm64') ||
                    video.snippet.title.toLowerCase().includes('mario 64');

            // Only ultimate salt is real from Styles
            case ('StylesX2'):
                return video.snippet.title.toLowerCase().includes('ultimate salt is real');

            // Only Fails of the Week from DotaCinema
            case ('DotaCinema'):
                return video.snippet.title.toLowerCase().includes('fails of the week');


            // Only Press Conferences and Mic'd up from Steelers
            case ('Pittsburgh Steelers'):
                return video.snippet.title.toLowerCase().includes('conference');


            // Only Mason, Arteezy, Sumail from DotaShaman
            case ('Dota Shaman'):
                return video.snippet.title.toLowerCase().startsWith('arteezy') ||
                    video.snippet.title.toLowerCase().startsWith('mason');

            // Only David Pakman videos 10 minutes or less
            case ('David Pakman Show'):
                return video.duration < 11;

            // All else are good
            default:
                return true;
        }
    });

    return videoList;
}