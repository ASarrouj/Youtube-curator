var fs = require('fs');
var readline = require('readline');
var { google } = require('googleapis');
var OAuth2 = google.auth.OAuth2;
var moment = require('moment');
var service = google.youtube('v3');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/youtube'];
const AUTH_DIR = './auth/'
const TOKEN_PATH = path.resolve(__dirname, AUTH_DIR + 'youtube-nodejs-quickstart.ign.json');
const TIMESTAMP_PATH = path.resolve(__dirname, './latestVideoTimestamp.txt');
const CLIENT_PATH = path.resolve(__dirname, AUTH_DIR + 'client_secret.ign.json');

fs.readFile(CLIENT_PATH, function processClientSecrets(err, content) {
    if (err) {
        console.error('Error loading client secret file: ' + err);
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
                console.error('Error while trying to retrieve access token', err);
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
        try {
            var paginatedSubResponse = await service.subscriptions.list({
                auth: auth,
                part: 'snippet',
                mine: true,
                maxResults: 50,
                pageToken: nextPageToken,
                order: 'alphabetical',
            })
        }
        catch (e) {
            console.error(e.response.data)
        }
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
    currentDaysUploads = await getVideoInfo(auth, currentDaysUploads);
    currentDaysUploads = filterOutPrivateVideos(currentDaysUploads)
    currentDaysUploads = applyChannelFilters(currentDaysUploads);

    // Sort videos by time uploaded, least recent first
    currentDaysUploads = currentDaysUploads.sort((video1, video2) => {
        return moment(video1.contentDetails.videoPublishedAt).unix() - moment(video2.contentDetails.videoPublishedAt).unix();
    })

    await addVideosToPlaylists(auth, currentDaysUploads);

    // Save timestamp of most recent video to file so next time we know the starting point (if there were new vids)
    if (currentDaysUploads.length > 0) {
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
        console.error('No timestamp found, defaulting to 1 day before now.');
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

    // Sequentially insert videos into appropriate playlist
    await videoList.reduce(async (prevPromise, nextVid) => {
        await prevPromise;

        if (nextVid.duration <= 30) {
            (await service.playlistItems.insert({
                auth: auth,
                part: 'snippet',
                resource:
                {
                    snippet: {
                        resourceId: nextVid.snippet.resourceId,
                        playlistId: subPlaylist.id,
                    }
                }
            }));
        }
        else {
            await service.playlistItems.insert({
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
        }
        return;
    }, Promise.resolve());
}

async function getVideoInfo(auth, videoList) {
    // For each playlist item, get its video object so we can get the duration (formatted to minutes) and tags
    videoList = await Promise.all(videoList.map(async video => {
        const videoResponse = await service.videos.list({
            auth: auth,
            part: 'contentDetails, snippet, status, liveStreamingDetails',
            id: video.snippet.resourceId.videoId,
            maxResults: 1,
        });

        video.duration = moment.duration(videoResponse.data.items[0].contentDetails.duration).asMinutes();
        video.tags = videoResponse.data.items[0].snippet.tags;
        video.privacyStatus = videoResponse.data.items[0].status.privacyStatus;
        video.liveBroadcastContent = videoResponse.data.items[0].snippet.liveBroadcastContent;
        if (videoResponse.data.items[0].liveStreamingDetails) {
            video.liveStreamingDetails = videoResponse.data.items[0].liveStreamingDetails;
        }
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
                    (video.tags?.includes('rap') || video.tags?.includes('hip hop'));

            // Only hip-hop and rap reviews from fantano
            case ('fantano'):
                return (video.snippet.title.toLowerCase().includes('memes') ||
                    video.tags?.includes('rap') || video.tags?.includes('hip hop')) && !/20\d\d/.test(video.snippet.title);

            // Only Mic'd up from NFL's Channel
            case ('NFL'):
                return video.snippet.title.toLowerCase().includes('mic\'d up') /*||
                    (video.snippet.title.includes('Highlights') && !video.snippet.title.includes('Season'))*/;

            // Remove Arlo news roundups, wishlist vids, splatoon vids, and top 10s
            case ('Arlo'):
                return !video.snippet.title.toLowerCase().includes('news roundup') &&
                    !video.snippet.title.toLowerCase().includes('predict') &&
                    !video.snippet.title.toLowerCase().includes('wishlist') &&
                    !video.snippet.title.toLowerCase().includes('splatoon');

            // Remove WAN show and PC builds/upgrades from LinusTechTips
            case ('Linus Tech Tips'):
                return !(video.snippet.title.toLowerCase().includes('tech upgrade') ||
                    video.tags?.includes('Tech Upgrade') ||
                    video.tags?.includes('tech upgrade') ||
                    video.tags?.includes('Tech Makeover') ||
                    video.tags?.includes('tech makeover'));

            case ('ShortCircuit'):
                return !(video.tags?.includes('keyboard') ||
                    video.tags?.includes('laptop') ||
                    (video.tags?.includes('3D') && video.tags?.includes('printer')) ||
                    video.tags?.includes('monitor') ||
                    video.tags?.includes('cooling') ||
                    video.tags?.includes('fan') ||
                    video.tags?.includes('fans') ||
                    video.tags?.includes('water cooling') ||
                    video.tags?.includes('case') ||
                    video.tags?.includes('trade show') ||
                    video.tags?.includes('desk'));

            // Only Hot Ones from First We Feast
            case ('First We Feast'):
                return video.snippet.title.toLowerCase().includes('hot ones');

            // Only Smash and Nintendo Reactions from Max Dood, plus street fighter 6
            case ('Maximilian Dood'):
                return !(video.tags?.includes('fatal fury') ||
                    video.tags?.includes('tekken') ||
                    video.tags?.includes('tekken 8') ||
                    video.tags?.includes('guilty gear') ||
                    video.tags?.includes('killer instinct') ||
                    video.tags?.includes('virtua fighter') ||
                    video.tags?.includes('mortal kombat') ||
                    video.tags?.includes('mortal kombat 1') ||
                    video.tags?.includes('armored core') ||
                    video.tags?.includes('final fantasy') ||
                    video.tags?.includes('kof') ||
                    video.tags?.includes('spider-man') ||
                    video.tags?.includes('fatal fury') ||
                    video.tags?.includes('bloodborne') ||
                    video.snippet.title?.toLowerCase().includes('matches') ||
                    video.tags?.includes('sonic'));

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

            // Only David Pakman videos 10 minutes or less, no caller videos or MyPillow guy
            case ('David Pakman Show'):
                return video.duration < 11 &&
                    !(video.snippet.title.toLowerCase().includes('caller') || 
                        video.snippet.title.toLowerCase().includes('mypillow') || 
                        video.snippet.title.toLowerCase().includes('mike lindell') ||
                        (video.snippet.title.toLowerCase().includes('trump') && video.snippet.title.toLowerCase().includes('lawyer')) ||
                        video.snippet.title.includes('?') ||
                        video.snippet.title.toLowerCase().includes('vivek ramaswamy') ||
                        video.snippet.title.toLowerCase().includes('audience') ||
                        video.tags?.includes('hate mail') ||
                        video.tags?.includes('voicemail'));

            // No Sonic videos from Werster
            case ('Werster'):
                return !video.snippet.title.toLowerCase().includes('sonic');

            case ('Brett Kollman'):
                return !(video.snippet.title.toLowerCase().includes('nfl draft'));

            case ('Kurzgesagt – In a Nutshell'):
                return !(video.snippet.title.toLowerCase().includes('virus') ||
                    video.snippet.title.toLowerCase().includes('body') ||
                    video.snippet.title.toLowerCase().includes('space'));

            case ('Dorkly'):
                return !(video.snippet.title.toLowerCase().includes('compilation'));

            case ('GeoWizard'):
                return video.tags?.includes('geoguessr') && !video.snippet.title.toLowerCase().includes('play along');

            case ('ProJared'):
                return !video.snippet.title.toLowerCase().includes('now in the 90s');

            case ('Ludwig'):
                return 'liveStreamingDetails' in video === false;

            case ('Destiny'):
                return 'liveStreamingDetails' in video === false;

            case ('Atrioc'):
                return true;

            case ('Lythero'):
                return !(video.snippet.title.toLowerCase().includes('half-life') ||
                    video.snippet.title.toLowerCase().includes('half life') ||
                    video.snippet.title.toLowerCase().includes('shadow the hedgehog') ||
                    video.snippet.title.toLowerCase().includes('l4d2'));
            // All else are good
            default:
                return true;
        }
    });

    return videoList;
}

function filterOutPrivateVideos(videoList) {
    return videoList.filter(video => {
        return (video.liveBroadcastContent == "none" || video.liveBroadcastContent == undefined) && video.privacyStatus === 'public';
    })
}