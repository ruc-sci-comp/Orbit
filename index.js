var Discord = require('discord.js');
var pg = require('pg');

var auth = require('./auth')
var config = require('./config')
var db = require('./db')
var github = require('./github')
var utilities = require('./utilities')

var dbConfig = config.dbConfig
var discordConfig = config.discordConfig
var githubConfig = config.githubConfig

const B = '\`\`\`';
const BB = B + B;

const pool = new pg.Pool({
    user: dbConfig.user,
    host: dbConfig.host,
    database: dbConfig.database,
    password: dbConfig.password,
    port: dbConfig.port,
});

var guild = undefined;

const client = new Discord.Client();

createChannel = async function(channels, name, type, parent=undefined) {
    for (var channel of channels.cache.values()) {
        if (channel.name == name && channel.type == type) {
            return channel.id;
        }
    }
    return (await guild.channels.create(name, {type: type, parent: parent})).id
}

prepareChannels = function(channels) {
    createChannel(channels, 'orbit', 'category').then( (orbitCategoryID) => {
        createChannel(channels, 'sandbox', 'text', orbitCategoryID);
        createChannel(channels, 'orbit-comms', 'text', orbitCategoryID);
    })

    for (course of githubConfig.courses) {
        createChannel(channels, course, 'category').then( (courseID) => {
            createChannel(channels, course + '-general', 'text', courseID);
            createChannel(channels, 'assignments', 'text', courseID);
            createChannel(channels, 'grades', 'text', courseID);
        });
    }
}

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    guild = client.guilds.cache.values().next().value;
    prepareChannels(guild.channels);
})

client.on('message', msg => {
    if (msg.content === 'ping') {
        msg.channel.send('pong');
    }

    var [command, ...args] = msg.content.split(' ');
    command = command.trim()

    if (!['!assignments', '!grades', '!info'].includes(command)) {
        return;
    }

    var courseID = guild.channels.cache.get(msg.channel.id).parent.name;

    auth.getToken(githubConfig.appID, githubConfig.installationID, githubConfig.clientID, githubConfig.clientSecret, githubConfig.privateKeyPath).then( (token) => {
        if (msg.content.startsWith('!assignments') && msg.channel.name == 'assignments') {
            if (args.length == 0) {
                assignmentType = 'current'
            }
            else {
                assignmentType = args[0].trim().toLowerCase();
            }
            github.getHomeworkProject(token, githubConfig.organization, courseID).then((projectID) => {
                github.getAssignments(token, projectID, assignmentType).then((assignments) => {
                    utilities.buildHomeworkList(assignments).then( (reply) => {
                        msg.channel.send(reply)
                            .then(_ => {})
                            .catch(console.error);
                    })
                })
            });
        }
        if (msg.content.startsWith('!grades') && msg.channel.name == 'grades') {
            db.getGitHubUserName(pool, msg.author.id).then( (githubUserName) => {
                github.getUserRepos(token, githubConfig.organization, githubUserName).then( (userRepositories) => {
                    github.getGrades(token, githubConfig.organization, userRepositories, githubConfig.gradeIssueTitle).then( (grades) => {
                        utilities.calculateGrade(grades).then( (reply) => {
                            msg.author.send(reply)
                                .then(_ => {msg.delete();})
                                .catch(console.error);
                        })
                    })
                })
            })
        }
        if (msg.content.startsWith('!info')) {
            if (args.length == 0) {
                msg.channel.send('I need more information! Provide some keywords and I will find some repositories that match!');
                return;
            }
            github.getReposWithTopics(token, githubConfig.organization, args).then(information => {
                utilities.buildReposWithTopicList(information, args).then( (reply) => {
                    msg.channel.send(reply)
                        .then(_ => {})
                        .catch(console.error);
                })
            })
        }
    })
});

client.login(discordConfig.token);
