const spotifyUrlInfo = require('spotify-url-info')(fetch);

async function test() {
  try {
    const data = await spotifyUrlInfo.getData('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    console.log('Track Data:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(err);
  }
}
test();
