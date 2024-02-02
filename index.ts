/*
Copyright 2023-2024 Daniel Ostrowski

This program is free software: you can redistribute it and/or modify it under 
the terms of the GNU General Public License as published by the Free Software 
Foundation, either version 3 of the License, or (at your option) any later 
version. This program is distributed in the hope that it will be useful, but 
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or 
FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more 
details.

You should have received a copy of the GNU General Public License along with 
this program. If not, see <https://www.gnu.org/licenses/>. 
*/

import { render } from "https://deno.land/x/dejs/mod.ts";
import { copy } from "https://deno.land/std@0.149.0/streams/conversion.ts";

/*
 ___ _   _ ____ _____ ____  _   _  ____ _____ ___ ___  _   _ ____  
|_ _| \ | / ___|_   _|  _ \| | | |/ ___|_   _|_ _/ _ \| \ | / ___| 
 | ||  \| \___ \ | | | |_) | | | | |     | |  | | | | |  \| \___ \ 
 | || |\  |___) || | |  _ <| |_| | |___  | |  | | |_| | |\  |___) |
|___|_| \_|____/ |_| |_| \_\\___/ \____| |_| |___\___/|_| \_|____/ 

0. Install deno from https://deno.com/ I am not sure how compatible this program
is with different versions of Deno, but for reference I used Deno 1.36.4 on
Linux
1. Edit the list of usernames below to be the list of usernames for the MAL
accounts you want to compare
2. Run this program by running:
deno run -A index.ts > report.html
from the terminal
3. Open report.html in a web browser
4. A json file will have been written for each user. Re-running this program
will use the json file instead of calling MAL again. Delete all the json files
before running this program to force fresh data to be fetched
5. View the json files to see what data is available for ideas on how to
improve this program
*/
const usernames = [/* Put list of string MAL usernames here */];

// The basic flow of this program is:
// 1. Fetch all specified users' anime lists. Each entry in a list contains
//    generic information about the anime (eg the English title) and also
//    information specific to that user's relationship to the anime (eg
//    how many episodes they have watched)
// 2. Make a master list of all anime that appears on at least one user's anime
//    list
// 3. Modify the in-memory representation of each user's anime list so it
//    contains each anime in the master list. This makes later processing
//    simpler. These added anime have a made-up dummy watch status to indicate
//    they aren't part of the user's real list. Eg, if you run this program
//    for me and you, and I have Clannad on my list but sadly you do not,
//    this step will copy the Clannad entry from the in-memory copy of my list
//    into the in-memory copy of your list, but the entry in your list will have
//    a watch "status" of -1 to indicate you don't have it on your real list
// 4. Then anime entries for the same anime from each person's list are grouped
//    together, sorted by the number of people who have the anime marked as
//    "watched". Eg if you run the program for you and me and both of us have
//    seen Bocchi the Rock but only I have seen Clannad, Bocchi the Rock will
//    be sorted first. The sorting order for ties is not meaningful.
// 5. The sorted data is rendered to HTML using an arcane HTML template inlined
//    in this file. This included template displays the sorted list of anime
//    in a grid, with each row corresponding to a single anime and each
//    column indicating either that user's score if they marked it as watched or
//    the number of episodes seen if that user is currently watching that anime
//    or whether the user dropped, put on hold, is planning to watch the anime,
//    or if the user did not have the anime on their list at all. Each row in
//    grid has CSS classes applied that contain information about the anime,
//    such as genre and target demographic. A simple header full of toggles at
//    the top of the report allows rows to be shown or hidden based on these
//    tags. 
// 6. The rendered HTML is written to standard output.

enum AnimeStatus {
    ABSENT = -1, // MAL does not give back -1 as a status; I made this up to
                 // represent when an anime was not actually in a user's list
    IN_PROGRESS = 1,
    WATCHED = 2,
    ON_HOLD = 3,
    DROPPED = 4,
    PLAN_TO_WATCH = 6,
}

interface Anime {
    status: AnimeStatus,
    score: number,
    is_rewatching: boolean,
    num_watched_episodes: number,
    anime_title: string,
    anime_title_eng: string,
    // MAL gives anime_num_episodes as 0 when the number of episodes is unknown 
    anime_num_episodes: number,
    // anime_id is the unique identifier used in all the filtering and
    // aggregating logic later on. If you see a Map or Set with number as a
    // type parameter, that is almost certainly referring to an anime_id
    anime_id: number,
    anime_score_val: number,
    // Seems to be one of ["TV", "Special", "Movie", "ONA", "OVA"]
    anime_media_type_string: string,
    genres: {
        name: string
    }[],
    demographics: {
        name: string
    }[]
    // MAL also categorizes anime based on "themes", but themes do not come
    // back in the API response for some reason. This is why eg "music" does
    // not show up as a tag you can filter by in the output HTML.
}

interface User {
    list: Anime[],
    username: string
}

async function getListForUser(username: string): Promise<Anime[]> {
    // If there is a JSON file in the current folder matching the username, that
    // file's data is assumed to be complete and current, so MAL is not called.
    // This is out of politeness to MAL, so if you are running this program
    // repeatedly while editing it, MAL is not repeatedly called.
    try {
        return JSON.parse(await Deno.readTextFile(`${username}.json`));
    }
    catch (_exception) {
        let list: Anime[] = [];
        let offset = 0;
        // The MAL endpoint this program hits gives paginated responses, but
        // nothing in the response actually indicates this. The caller has to
        // just keep requesting pages until you get no results back. The
        // endpoint gives up to 300 anime back in a page of results.
        while (true) {
            // If you leave off status=7, then if a user has their list
            // configured to initially load only finished anime, then without
            // status=7 only finished anime would be returned
            console.error(`Fetching part of list for user ${username} - offset is ${offset}`);
            const response = await fetch(`https://myanimelist.net/animelist/${username}/load.json?status=7&offset=${offset}`);
            const listPart = await response.json();
            if (listPart.length === 0) {
                break;
            }
            else {
                list = [...list, ...listPart];
                offset += 300;
            }
        }
        await Deno.writeTextFile(`${username}.json`, JSON.stringify(list));
        // I don't remember if there is a reason why this does not simply say
        // return list;
        // I guess this was a way to test that loading a list from a file works
        return await getListForUser(username);
    }
}

async function getDataForUsers(usernames: string[]): Promise<User[]> {
    return await Promise.all(
        usernames.map(async (username) => ({
            list: await getListForUser(username),
            username
        }))
    );
}

function getUniqueAnimeInfo(userdata: User[]): {uniqueAnime: Map<number, Anime>, uniqueAnimeIds: Set<number>} {
    const uniqueAnime: Map<number, Anime> = new Map(userdata.flatMap(user => user.list).map(anime => [anime.anime_id, anime]));
    const uniqueAnimeIds: Set<number> = new Set(Array.from(uniqueAnime).map(animeIdAnimePair => animeIdAnimePair[0]));
    return {
        uniqueAnime,
        uniqueAnimeIds
    }
}

function sortByMatches(userdata: User[], predicate: ((anime: Anime) => boolean)): Anime[][][] {
    // This function does too much. It not only does sorting, but it also does
    // the work of ensuring that each anime that appears on at least one user's
    // list appears on every user's list, since that simplifies some logic later

    // For convenience, get the set of all anime that appear in any of the
    // users' lists, and make a map from each anime's unique id to one instance
    // of the anime data. It doesn't matter which user's list the anime data
    // comes from since this is only used to get non-user-specific data
    // associated with the anime, such as the English title
    const {uniqueAnime, uniqueAnimeIds} = getUniqueAnimeInfo(userdata);

    // Each entry in animeMaps is a working copy of a single user's anime list.
    // Instead of each entry being Anime[], for convenient look-ups each entry
    // is a map from anime_id to Anime
    const animeMaps: Map<number, Anime>[] = userdata.map(user => new Map<number, Anime>(user.list.map(anime => [anime.anime_id, anime])));
    // For convenience, for each anime that appears on any list, make sure each
    // user's animeMap contains that anime.
    // If the user does not actually have that anime on their list, include the
    // anime with the custom status of -1 aka ABSENT
    for (const anime_id of uniqueAnimeIds.keys()) {
        for (const animeMap of animeMaps) {
            if (animeMap.get(anime_id) === undefined) {
                animeMap.set(anime_id, {
                    ...(uniqueAnime.get(anime_id) as Anime),
                    status: AnimeStatus.ABSENT
                });
            }
        }
    }
    const results: Anime[][][] = [];
    // We want to group anime based on for how many users the predicate is true.
    // For example, with four users and a predicate of
    // anime => anime.status === AnimeStatus.WATCHED
    // we first want to get all anime that all 4 users have watched, then all
    // anime that 3 users have watched, etc - so the first row in results would
    // be an Anime[][], where every anime was watched by 4 people, and in that
    // Anime[][], each entry contains the list of anime list entries for a
    // single anime. So if the only anime watched by all 4 people is
    // Kimi ni Todoke season 1, then results[0] will have length 1, and
    // results[0][0] will contain the entries from all 4 users' lists for
    // Kimi ni Todoke season 1.
    for (let matchCount = userdata.length; matchCount >= 0; matchCount--) {
        const animeIdsWithMatchCount = Array.from(uniqueAnimeIds).filter(anime_id =>
            animeMaps.filter(animeMap => predicate(animeMap.get(anime_id) as Anime)).length === matchCount
            );
        // For each anime, get
        // [first user's data for that anime, second user's data for that anime, etc]
        const animeWithMatchCountForUsers: Anime[][] =
            animeIdsWithMatchCount.map(anime_id => animeMaps.map(animeMap => (animeMap.get(anime_id) as Anime)));
        results.push(animeWithMatchCountForUsers);
    }
    return results;
}

// To support some basic filtering options in the included template, every
// anime is assigned a set of tags. This includes all genres (eg "drama") MAL
// says the anime has, the target demographic (eg "shoujo") if any that MAL says
// the anime has, as well as some custom ones like "ten-out-of-ten" for an
// anime that at least one user has marked with a perfect 10/10 score. These
// tags are then added as CSS classes on the row representing that anime.
// This tagging process could be enhanced with additional custom tags, or tags
// with data from other sources.

function getUniqueTags(users: User[]): string[] {
    const uniqueTags: Set<string> = new Set<string>();
    users.flatMap(user => user.list).flatMap(anime => animeToTags(anime, users))
        .forEach(tag => uniqueTags.add(tag));
    return Array.from(uniqueTags);
}

function animeToTags(anime: Anime, users: User[]): string[] {
    const tags = [...anime.demographics.map(demographic => demographic.name), ...anime.genres.map(genre => genre.name)]
        .map(tag => tag.toLocaleLowerCase().replaceAll(' ', '-'))
    // List of each separate time this anime has appeared in anyone's list
    const animeAppearances = users.flatMap(user => user.list.filter(userAnime => userAnime.anime_id === anime.anime_id));
    if (animeAppearances.filter(userAnime => userAnime.status === AnimeStatus.IN_PROGRESS).length > 0) {
        tags.push('in-progress');
    }
    if (animeAppearances.filter(userAnime => userAnime.score === 10).length > 0) {
        tags.push('ten-out-of-ten');
    }
    if (anime.anime_media_type_string === 'Movie') {
        tags.push('movie');
    }
    // If it's not a movie and has no more than 3 episodes. Must check to ensure
    // at least 1 episode because anime with an unknown number of episodes are
    // represented as having 0 episodes. The included template has "short"
    // anime toggled as hidden by default since it seemed weird to list things
    // like single-episode OVAs with equal weight alongside complete seasons and
    // entire series
    if (anime.anime_media_type_string !== 'Movie' && 0 < anime.anime_num_episodes && anime.anime_num_episodes <= 3) {
        tags.push('short');
    }
    return tags;
}

// This controls the text displayed in the cell for a particular user and a
// particular anime, as well as CSS classes applied to the cell (which are
// used for color-coding in the included template).
function animeToDisplayForm(anime: Anime): {text: string, cssClass: string} {
    switch (anime.status) {
        case AnimeStatus.ABSENT:
            return {
                text: "",
                cssClass: "absent"
            };
        case AnimeStatus.WATCHED:
            return {
                text: (anime.score > 0 ? anime.score.toString() : "Unscored"),
                cssClass: "watched"
            };
        case AnimeStatus.IN_PROGRESS:
            return {
                text: `${anime.num_watched_episodes} / ${anime.anime_num_episodes}`,
                cssClass: "inprogress"
            };
        case AnimeStatus.ON_HOLD:
            return {
                text: "On hold",
                cssClass: "onhold"
            }
        case AnimeStatus.PLAN_TO_WATCH:
            return {
                text: "Planning to watch",
                cssClass: "plantowatch"
            };
        case AnimeStatus.DROPPED:
            return {
                text: "Dropped",
                cssClass: "dropped"
            };
        default:
            return {
                text: `Unrecognized status ${anime.status}`,
                cssClass: "unknown"
            };
    }
}

const userdata = await getDataForUsers(usernames);
const matches = sortByMatches(userdata, anime => anime.status === AnimeStatus.WATCHED);
const uniqueTags = getUniqueTags(userdata);
uniqueTags.sort();

// This template really should be a separate file.
const template = `
<html>
    <head>
        <title>Grouped</title>
        <style>
            a, a:visited {
                color: black;
                text-decoration: none;
            }
            table, td {
                border: 1px solid black;
                border-collapse: collapse;
            }
            td {
                min-width: 8vw;
                height: 3vh;
                background: mintcream;
            }
            tr.headerrow > td {
                background: mediumaquamarine;
            }
            .absent {
                background: mintcream;
            }
            .watched {
                background: aquamarine;
            }
            .inprogress {
                background: aqua;
            }
            .onhold {
                background: wheat;
            }
            .plantowatch {
                background: plum;
            }
            .dropped {
                background: salmon;
            }
            .unknown {
                background: hotpink;
            }
            .mal-score-higher {
                background: #FAF0DD;
            }
            .mal-score-lower {
                background: #DCD0FF;
            }
            .hidden {
                display: none;
            }
            .checkboxWrapper {
                width: 32%;
                display: inline-block;
            }
            .filterGroup {
                display: inline-block;
                width: 32%;
                padding-bottom: 1em;
            }
            .filterGroup > p {
                margin: 0;
            }
        </style>
        <script>
            function toggleVisibility() {
                const checkboxes = document.getElementsByTagName('input');
                const tagNameCheckedFilterTypeTuples = [];
                for (var i = 0; i < checkboxes.length; i++) {
                    tagNameCheckedFilterTypeTuples.push([checkboxes.item(i).value, checkboxes.item(i).checked, checkboxes.item(i).className]);
                }
                const animeRows = document.getElementsByClassName('anime');
                const isOrCriteriaSet = tagNameCheckedFilterTypeTuples.filter(tuple => tuple[2] === 'anyof' && tuple[1]).length > 0;
                const isAndCriteriaSet = tagNameCheckedFilterTypeTuples.filter(tuple => tuple[2] === 'allof' && tuple[1]).length > 0;
                for (var i = 0; i < animeRows.length; i++) {
                    const anime = animeRows.item(i);
                    const passesOrCriteria = tagNameCheckedFilterTypeTuples.filter(tuple => tuple[2] === 'anyof' && tuple[1] && anime.classList.contains(tuple[0])).length > 0;
                    const passesAndCriteria = !isAndCriteriaSet || tagNameCheckedFilterTypeTuples.filter(tuple => tuple[2] === 'allof' && tuple[1] && !anime.classList.contains(tuple[0])).length === 0;
                    const possiblyShouldBeVisible = passesOrCriteria && passesAndCriteria;
                    const mustBeHidden = tagNameCheckedFilterTypeTuples.filter(tuple => tuple[2] === 'noneof' && tuple[1] && anime.classList.contains(tuple[0])).length > 0;
                    const isVisible = possiblyShouldBeVisible && !mustBeHidden;
                    if (isVisible) {
                        anime.classList.remove('hidden');
                    }
                    else {
                        anime.classList.add('hidden');
                    }
                }
            }
            function checkboxAll(checked, filterType) {
                const checkboxes = document.getElementsByClassName(filterType);
                for (var i = 0; i < checkboxes.length; i++) {
                    checkboxes.item(i).checked = checked;
                }
                toggleVisibility();
            }
        </script>
    </head>
    <body onload="toggleVisibility();">
        <% for (var filterType of ['anyof', 'allof', 'noneof']) { %>
            <div class="filterGroup">
                <p>
                    <%= {'anyof' : 'Include anime with any of these tags...' , 'allof': '...and with all of these tags...', 'noneof' : '...unless they have any of these tags'}[filterType] %>
                </p>
                <div>
                    <button onclick="checkboxAll(false, '<%= filterType %>')">Uncheck all</button>
                    <button onclick="checkboxAll(true, '<%= filterType %>')">Check all</button>
                </div>
                <div>
                    <% for (var i = 0; i < uniqueTags.length; i++) { %>
                        <% tag = uniqueTags[i] %>
                        <% if (i % 3 === 0) { %>
                            <div>
                        <% } %>
                        <div class="checkboxWrapper">
                            <input class="<%= filterType %>" type="checkbox"
                                <% if (filterType === 'anyof' || (filterType === 'noneof' && tag === 'short')) { %>
                                    checked='true'
                                <% } %>
                                value="<%= tag %>" onchange="toggleVisibility()">
                                <%= tag %>
                            </input>
                        </div>
                        <% if (i % 3 === 2 || i === uniqueTags.length - 1) { %>
                            </div>
                        <% } %>
                    <% } %>
                </div>
            </div>
        <% } %>
        <table>
            <tr>
                <td>&nbsp;</td>
                <td>MAL Average</td>
                <td>Group Average</td>
                <% for (let username of usernames) { %>
                    <td><%= username %></td>
                <% } %>
            </tr>
            <% for (let matchGroupIndex = 0; matchGroupIndex < matches.length; matchGroupIndex++) { %>
                <% const matchGroup = matches[matchGroupIndex]; %>
                <tr class="headerrow">
                    <td>Anime watched by <%= matches.length - matchGroupIndex - 1 %> <%= matches.length - matchGroupIndex - 1 === 1 ? 'person' : 'people' %></td>
                    <td></td>
                    <td></td>
                    <% for (let username of usernames) { %>
                    <td>&nbsp;</td>
                    <% } %>
                </tr>
                <% for (let match of matchGroup) { %>
                    <% let malScore = (match[0].anime_score_val > 0 ? match[0].anime_score_val.toFixed(2) : ""); %>
                    <% let groupScore = match.filter(anime => anime.status === 2 && anime.score !== 0).length === 0 ? "" : (match.filter(anime => anime.status === 2).map(anime => anime.score).reduce((a, b) => a + b, 0) / match.filter(anime => anime.status === 2 && anime.score !== 0).length).toFixed(2) %>
                    <% let scoreDifferenceTag = groupScore === "" ? "" : (new Number(malScore) > new Number(groupScore) ? "mal-score-higher" : "mal-score-lower") %> 
                    <tr class="anime <%= animeToTags(match[0], users).join(' ') %>">
                        <td><a href='https://myanimelist.net/anime/<%= match[0].anime_id %>'><%= match[0].anime_title_eng || match[0].anime_title %></a></td>    
                        <td><%= malScore %></td>
                        <td class="<%= scoreDifferenceTag %>"><%= groupScore %> </td>
                        <% for (let anime of match) { %>
                        <td class="<%= animeToDisplayForm(anime).cssClass%>"><%= animeToDisplayForm(anime).text %></td>
                        <% } %>
                    </tr>
                <% } %>
                <tr>&nbsp;</tr>
            <% } %>
        </table>
    </body>
</html>
`;

// We need to pass in not just the anime list data but also the functions that
// we want to invoke as part of rendering the template.
const html = await render(template, {users: userdata, usernames, matches, animeToDisplayForm, animeToTags, uniqueTags});
await copy(html, Deno.stdout);
