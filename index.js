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

async function send_dm(msg, content) {
    return msg.author.send(content);
}

async function send_text(msg, content) {
    return msg.channel.send(content);
}

async function send_message(msg, content) {
    if (msg.channel.type == 'dm') {
        return send_dm(msg, content);
    }
    else {
        return send_text(msg, content);
    }
}

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

    createChannel(channels, githubConfig.course, 'category').then( (courseID) => {
        createChannel(channels, githubConfig.course + '-general', 'text', courseID);
        createChannel(channels, 'assignments', 'text', courseID);
    });
}

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    guild = client.guilds.cache.values().next().value;
    prepareChannels(guild.channels);
})

client.on('message', async msg => {

    if (msg.content === '!ping') {
        send_message(msg, 'pong!');
        return;
    }

    var [command, ...args] = msg.content.split(' ');
    command = command.trim()

    if (!['!assignments', '!grades', '!info', '!register'].includes(command)) {
        return;
    }

    var graphqlWithAuth = await auth.getGraphqlWithAuth(githubConfig.appID, githubConfig.installationID, githubConfig.privateKeyPath);
    var restWithAuth = await auth.getRestWithAuth(githubConfig.appID, githubConfig.installationID, githubConfig.clientID, githubConfig.clientSecret, githubConfig.privateKeyPath);

    if (msg.content.startsWith('!assignments')) {
        if (args.length == 0) {
            assignmentType = 'current';
        }
        else {
            assignmentType = assignmentType[0].trim().toLowerCase();
            if (assignmentType == 'unreleased') {
                assignmentType = 'current';
            }
        }

        var cards = await github.getCards(graphqlWithAuth, githubConfig.organization, githubConfig.course, assignmentType)
            reply = '';
            for (card of cards) {
                reply += card.note + '\n';
            }
            send_dm(msg, reply)
                .then(_ => {})
                .catch(console.error);
    }
    if (msg.content.startsWith('!grades')) {
        var githubUserName = await db.getGitHubUserName(pool, msg.author.id);
        var cards = await github.getCards(graphqlWithAuth, githubConfig.organization, githubConfig.course, 'completed')
        score = 0.0;
        total = 0.0;
        reply = B;

        for (var card of cards) {
            var c = JSON.parse(card.note);
            var repo = c.name + '-' + githubUserName
            try {
                var raw_grade = await github.getActionAnnotation(restWithAuth, 'ruc-sci-comp', repo);
            }
            catch (error) {
                var raw_grade = `Points 0/${c.points}`
            }
            var [grade_score, grade_total] = raw_grade.split(' ')[1].trim().split('/');
            reply += c.name + ': ' + grade_score.padStart(3, ' ') + '/' + grade_total.padStart(3, ' ') + '\n';
            if (c.points > 0) {
                score += grade_score * githubConfig.gradeWeights[c.category];
                total += grade_total * githubConfig.gradeWeights[c.category];
            }
        }

        if (total > 0) {
            reply += `${BB}Weighted Course Grade: ${score}/${total} = ${100.0 * score/total}${B}`;
            send_dm(msg, reply)
                .then(_ => {
                    if (msg.channel.type == 'text') {
                        msg.delete();
                    }
                })
                .catch(console.error);
        }
        else {
            send_dm(msg, "No assignments have been released for grading!")
        }
    }

    if (msg.content.startsWith('!info')) {
        if (args.length == 0) {
            send_message(msg, 'I need more information! Provide some keywords and I will find some repositories that match!');
            return;
        }
        var information = await github.getReposWithTopics(graphqlWithAuth, githubConfig.organization, args);
        reply = `The following repositories are tagged with \`${args.join('\`, or \`')}\`\n`
        reply += information.join('\n')
        send_message(msg, reply)
            .then(_ => {})
            .catch(console.error);
    }

    if (msg.content.startsWith('!register')) {
        var dmChannel = await msg.author.createDM();
        var filter = m => m.content.length != 0;
        var count = await db.countUser(pool, msg.author.id);
        if (count > 0) {
            dmChannel.send('`This Discord account is already registered! Contact your instructor.`')
            return;
        }
        dmChannel.send('`Enter your full name (First Last) / [or cancel to quit]`').then(() => {
            dmChannel.awaitMessages(filter, { max: 1, time: 20000, errors: ['time'] }).then(name => {
                if (name.first().content.toLowerCase() == 'cancel') {
                    return;
                }
                dmChannel.send('`Enter your GitHub Username / [or cancel to quite]`').then(() => {
                    dmChannel.awaitMessages(filter, { max: 1, time: 20000, errors: ['time'] }).then(githubUserName => {
                        if (githubUserName.first().content.toLowerCase() == 'cancel') {
                            return;
                        }
                        dmChannel.send(`\`Are you sure you want to proceed? This cannot be undone! [yes/no]\`\n\`Name: ${name.first().content}\`\n\`GitHub: ${githubUserName.first().content}\``).then(() => {
                            dmChannel.awaitMessages(filter, { max: 1, time: 20000, errors: ['time'] }).then(confirmation => {
                                if (confirmation.first().content.toLowerCase() == 'yes') {
                                    db.registerUser(pool, name.first().content, msg.author.id, githubUserName.first().content).then( rowCount => {
                                        if (rowCount == 1) {
                                            let studentRole = guild.roles.cache.find(role => role.name === "Student");
                                            let member = guild.members.cache.find(member => member.id === msg.author.id)
                                            member.roles.add(studentRole).catch(console.error);
                                            dmChannel.send(`Registered!`)
                                        }
                                        else {
                                            dmChannel.send('`Something went wrong while trying to register! Contact your instructor!`');
                                        }
                                    })
                                }
                            })
                        })
                    })
                });
            })
        })
    }
});

client.login(discordConfig.token);
